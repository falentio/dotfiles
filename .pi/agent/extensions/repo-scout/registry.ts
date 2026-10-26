/**
 * Package name -> a cloneable repo, at the ref that serves a version.
 *
 * "Which repo serves this package" is a provenance question, so every answer says where it came
 * from and how much to trust it: a manifest field is stated, a name search is a guess. The ref is a
 * separate question — registries publish versions, not git tags — so a candidate tag is only
 * reported after git confirms it exists.
 *
 * The parsers are pure and fixture-tested. Network and git live behind RegistryDeps, and only
 * resolvePackageRepo reaches them.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const PACKAGE_SOURCES = [
	'npm',
	'jsr',
	'crate',
	'pypi',
	'dockerhub',
	'go',
	'hex',
	'maven',
	'nuget',
	'zig',
] as const;

/** A package registry this tool can read. */
export type PackageSource = (typeof PACKAGE_SOURCES)[number];

/** repository: browsable code. tarball: provenance only, not a git repo. */
export type RepoKind = 'repository' | 'tarball';

/** stated: the publisher said it. guess: a name search matched it. */
export type Confidence = 'stated' | 'guess';

/** Which field the URL came out of, so a reader can judge it. */
export type RepoVia =
	| 'manifest'
	| 'npm-tarball'
	| 'jsr-deno-json'
	| 'pypi-project-urls'
	| 'dockerhub-description'
	| 'github-search'
	| 'go-proxy-origin'
	| 'go-import-meta'
	| 'hex-links'
	| 'maven-pom'
	| 'nuget-nuspec'
	| 'zpm-index';

export type RefKind = 'tag' | 'branch';

export type RepoRef = {
	/** A git URL repo_scout can clone, or a tarball URL when kind is tarball. */
	url: string;
	kind: RepoKind;
	via: RepoVia;
	confidence: Confidence;
	/** A ref git confirmed exists for the requested version. */
	ref: string | null;
	refKind: RefKind | null;
	/** Tags tried in order when no ref matched. */
	refCandidates: string[];
};

export type PackageRepoResult = {
	package: string;
	source: PackageSource;
	/** The requested version, or the registry latest when none was asked for. */
	version: string | null;
	repos: RepoRef[];
	warnings: string[];
};

/** Registry fields this tool reads. Loose: registries evolve. */
export type Manifest = {
	homepage?: unknown;
	repository?: unknown;
	bugs?: unknown;
	dist?: unknown;
	githubRepository?: unknown;
};

/** Forge hosts where /owner/name is a repo and anything deeper is a page inside it. */
const FORGE_HOSTS = new Set([
	'github.com',
	'gitlab.com',
	'codeberg.org',
	'bitbucket.org',
	'gitea.com',
	'git.sr.ht',
]);

/**
 * Is this host a git host? A docs site or a hub page can also have two path segments, so the host is
 * what decides: a known forge, a self-hosted GitLab, or anything served under a git. prefix.
 */
const isForgeHost = (hostname: string): boolean => {
	const host = hostname.toLowerCase();
	if (FORGE_HOSTS.has(host)) return true;
	if (host.includes('gitlab.') || host.includes('github.')) return true;
	return host.startsWith('git.');
};

/** Forge routes a package homepage points at by mistake (a bugs page, not a repo). */
const SITE_ROUTES = new Set(['issues', 'pulls', 'releases', 'wiki', 'actions', 'settings', 'security', 'blob', 'tree', 'commit']);

const asString = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim() : undefined;

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** A published version is one URL path segment: anything else never reaches a registry. */
const versionOf = (value: string | undefined): string | undefined => {
	if (!value) return undefined;
	if (!VERSION.test(value) || value.includes('..') || value.endsWith('.')) {
		throw new Error('version is not a published version: ' + JSON.stringify(value));
	}
	return value;
};

/** npm names are URL paths: the scope's @ stays, the slash is %2F. */
const npmPath = (name: string): string => {
	const encoded = name.replace(/^@/, '').split('/').map(encodeURIComponent).join('%2F');
	return name.startsWith('@') ? '@' + encoded : encoded;
};

const warnMissingVersion = (
	source: PackageSource,
	version: string | undefined,
	known: string[],
	warnings: string[],
): void => {
	if (version && known.length > 0 && !known.includes(version)) {
		warnings.push('no ' + source + ' release ' + version + '; the fields may describe another release');
	}
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

/**
 * Normalize a repo reference to a clone URL. Handles what registries emit: a string, { url },
 * git+https://, git://, git+ssh://, git@host:owner/name, github:owner/name, and owner/name.
 */
export function normalizeRepoUrl(value: unknown): string | undefined {
	let raw: string | undefined;
	if (typeof value === 'string') raw = value.trim();
	else {
		const record = asRecord(value);
		raw = record ? (asString(record.url) ?? asString(record.repository)) : undefined;
	}
	if (!raw) return undefined;

	const short = /^github:([\w.-]+\/[\w.-]+)$/i.exec(raw);
	if (short) return 'https://github.com/' + short[1];

	const bare = /^([\w.-]+\/[\w.-]+)(?:#.*)?$/.exec(raw);
	if (bare && !raw.includes('://')) return 'https://github.com/' + bare[1];

	let url = raw
		.replace(/^git\+/, '')
		.replace(/^git:\/\//, 'https://')
		.replace(/^ssh:\/\/(?:[^@/]+@)?/, 'https://')
		.replace(/^git@([^:]+):/, 'https://$1/');
	url = url
		.replace(/#.*$/, '')
		.replace(/\.git$/, '')
		.replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(url)) return undefined;
	return url;
}

const IP_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * A host a package manifest may point git at. Metadata is third-party input, so an IP literal, a
 * loopback name, or a private suffix is refused: `git ls-remote` would otherwise become egress to
 * whatever a package author wrote down, metadata endpoints included.
 */
export const isPublicGitHost = (hostname: string): boolean => {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!host) return false;
	if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
	return !IP_LITERAL.test(host) && !host.includes(':');
};

/**
 * Is this URL a repo root rather than a page inside one, or beside it? A homepage (zod.dev) or a
 * bugs page (github.com/o/n/issues) is provenance but cannot be cloned.
 *
 * The https and public-host checks come first, so the `.git` suffix proves a git URL without
 * bypassing them.
 */
export function isRepoRootUrl(url: string, raw?: unknown): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== 'https:' || !isPublicGitHost(parsed.hostname)) return false;
	// A URL the publisher wrote with a .git suffix is a git URL by construction, whatever the host.
	// Test the path, not the query: gitbox.apache.org/repos/asf?p=x.git is a gitweb page.
	const original = asString(raw);
	const beforeQuery = original?.split(/[?#]/)[0];
	if (beforeQuery && /\.git\/?$/i.test(beforeQuery)) return true;
	if (!isForgeHost(parsed.hostname)) return false;
	const parts = parsed.pathname.split('/').filter(Boolean);
	return parts.length === 2 && !SITE_ROUTES.has((parts[1] ?? '').toLowerCase());
}

/** A manifest URL that cannot be cloned, so the drop can be named instead of silent. */
const ignoredRepository = (value: unknown): string | undefined => {
	const url = normalizeRepoUrl(value);
	return url && !isRepoRootUrl(url, value) ? url : undefined;
};

const makeRef = (url: string, via: RepoVia, kind: RepoKind = 'repository'): RepoRef => ({
	url,
	kind,
	via,
	confidence: 'stated',
	ref: null,
	refKind: null,
	refCandidates: [],
});

/**
 * Git URLs out of a manifest: the repository field first, then a homepage that is a repo.
 *
 * Every field goes through the repo-root test. Publishers put a docs site, a PyPI project page, or a
 * bugs page in `repository` often enough that trusting the field would hand a caller a URL that
 * cannot be cloned.
 */
export function reposFromManifest(manifest: Manifest, via: RepoVia = 'manifest'): RepoRef[] {
	const refs: RepoRef[] = [];
	const push = (value: unknown) => {
		const url = normalizeRepoUrl(value);
		if (!url || !isRepoRootUrl(url, value)) return;
		if (refs.some((existing) => existing.url === url)) return;
		refs.push(makeRef(url, via));
	};
	push(manifest.repository);
	push(manifest.githubRepository);
	push(manifest.homepage);
	return refs;
}

/** The latest version an npm packument points at. */
export function npmVersion(packument: unknown): string | undefined {
	return asString(asRecord(asRecord(packument)?.['dist-tags'])?.['latest']);
}

/** The manifest for a version, falling back to the packument root for older publishes. */
export function npmManifest(packument: unknown, version?: string): Manifest | undefined {
	const record = asRecord(packument);
	if (!record) return undefined;
	const wanted = version ?? npmVersion(packument);
	const versions = asRecord(record.versions);
	const entry = wanted && versions ? asRecord(versions[wanted]) : undefined;
	return entry ? (entry as Manifest) : (record as Manifest);
}

/** The npm tarball: provenance that cannot be cloned as a repo. */
export function tarballFromNpmManifest(manifest: Manifest): RepoRef | undefined {
	const tarball = asString(asRecord(manifest.dist)?.tarball);
	return tarball ? makeRef(tarball, 'npm-tarball', 'tarball') : undefined;
}

/** PyPI project URLs: Source/Code/Repository first, then Homepage. */
export function reposFromPypi(info: unknown): RepoRef[] {
	const record = asRecord(info);
	if (!record) return [];
	const refs = reposFromManifest({ repository: record.project_url, homepage: record.home_page }, 'pypi-project-urls');
	const urls = asRecord(record.project_urls);
	if (urls) {
		for (const key of ['Source', 'Source Code', 'Code', 'Repository', 'Homepage', 'Home']) {
			const url = normalizeRepoUrl(urls[key]);
			if (!url || !isRepoRootUrl(url, urls[key])) continue;
			if (refs.some((existing) => existing.url === url)) continue;
			refs.push(makeRef(url, 'pypi-project-urls'));
		}
	}
	return refs;
}

/** JSR publishes each version's deno.json; that is where githubRepository lives. */
export function reposFromJsrDenoJson(document: unknown): RepoRef[] {
	return reposFromManifest((asRecord(document) ?? {}) as Manifest, 'jsr-deno-json');
}

/** A Docker Hub description is free text; take the repo roots out of it. */
export function reposFromDockerhubHub(document: unknown): RepoRef[] {
	const record = asRecord(document);
	if (!record) return [];
	const text = [asString(record.description), asString(record.full_description)].filter(Boolean).join(' ');
	const refs: RepoRef[] = [];
	for (const match of text.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) {
		const url = normalizeRepoUrl(match[0].replace(/[.,;:]+$/, ''));
		if (!url || !isRepoRootUrl(url)) continue;
		if (refs.some((existing) => existing.url === url)) continue;
		refs.push(makeRef(url, 'dockerhub-description'));
	}
	return refs;
}

/** GitHub search hits: a name match is not provenance, so these are guesses. */
export function reposFromGithubSearch(payload: unknown): RepoRef[] {
	const items = asRecord(payload)?.items;
	if (!Array.isArray(items)) return [];
	const refs: RepoRef[] = [];
	for (const item of items) {
		const url = normalizeRepoUrl(asRecord(item)?.html_url);
		if (!url || refs.some((existing) => existing.url === url)) continue;
		refs.push({ ...makeRef(url, 'github-search'), confidence: 'guess' });
	}
	return refs;
}


/**
 * Go modules are fetched through proxy.golang.org, which reports the origin repo of a version in
 * `Origin.URL`. That field is why a Go answer does not need a name search: the proxy already knows
 * which git repo served the module. Uppercase letters in a module path are escaped as `!lower`.
 */
export const escapeGoModule = (module: string): string => module.replace(/[A-Z]/g, (char) => '!' + char.toLowerCase());

/** A module path names a host with a dot, then a path: github.com/o/n, gopkg.in/yaml.v3. */
export const isGoModulePath = (name: string): boolean =>
	/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[A-Za-z0-9._~/-]+$/.test(name) && !name.includes('..') && !name.startsWith('/') && !name.endsWith('/');

/**
 * The version, origin repo, and VCS from a proxy `.info` or `@latest` response.
 *
 * The proxy builds Origin from the module's VCS, so its URL is a git origin by construction even
 * when the host is not a known forge (go.googlesource.com/text). The caller still checks the host is
 * public before git contacts it.
 */
export function parseGoVersionInfo(document: unknown): { version: string | null; repo: string | null; vcs: string | null } {
	const record = asRecord(document);
	const origin = asRecord(record?.Origin);
	return {
		version: asString(record?.Version) ?? null,
		repo: normalizeRepoUrl(asString(origin?.URL)) ?? null,
		vcs: asString(origin?.VCS) ?? null,
	};
}

/** The go-import meta tag a vanity module path serves: "prefix git url". */
export function goImportRepo(html: string): string | undefined {
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		if (!/\bname=["']go-import["']/i.test(tag)) continue;
		const content = /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1];
		const [prefix, vcs, url] = content?.trim().split(/\s+/) ?? [];
		if (!prefix || vcs !== 'git' || !url) continue;
		const normalized = normalizeRepoUrl(url);
		if (normalized) return normalized;
	}
	return undefined;
}

/** Hex publishes a package's links and every release; the GitHub link is the usual repo field. */
export function parseHexPackage(document: unknown): { latest: string | null; versions: string[]; repos: RepoRef[] } {
	const record = asRecord(document);
	const releases = Array.isArray(record?.releases) ? record.releases : [];
	const versions = releases
		.map((entry) => asString(asRecord(entry)?.version))
		.filter((entry): entry is string => Boolean(entry));
	const links = asRecord(asRecord(record?.meta)?.links);
	const order = ['github', 'gitlab', 'source', 'source code', 'repository', 'code'];
	const entries = (links ? Object.entries(links) : []).sort(([a], [b]) => {
		const rank = (key: string) => {
			const at = order.indexOf(key.toLowerCase());
			return at < 0 ? order.length : at;
		};
		return rank(a) - rank(b);
	});
	const refs: RepoRef[] = [];
	for (const [, value] of entries) {
		const url = normalizeRepoUrl(value);
		if (!url || !isRepoRootUrl(url, value)) continue;
		if (refs.some((existing) => existing.url === url)) continue;
		refs.push(makeRef(url, 'hex-links'));
	}
	return { latest: versions[0] ?? null, versions, repos: refs };
}

/** The tag a POM's <scm> block names, when the publisher wrote one. */
export function pomTag(xml: string): string | undefined {
	const scm = /<scm>([\s\S]*?)<\/scm>/i.exec(xml)?.[1];
	const tag = scm ? /<tag>\s*([^<\s]+)\s*<\/tag>/i.exec(scm)?.[1] : undefined;
	return tag && !tag.startsWith('-') ? tag : undefined;
}

/** maven-metadata.xml: the release, the latest, and every version in the directory. */
export function parseMavenMetadata(xml: string): { release: string | null; latest: string | null; versions: string[] } {
	const versions = [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((match) => match[1] as string);
	return {
		release: /<release>\s*([^<\s]+)\s*<\/release>/.exec(xml)?.[1] ?? null,
		latest: /<latest>\s*([^<\s]+)\s*<\/latest>/.exec(xml)?.[1] ?? null,
		versions,
	};
}

const scmRepo = (value: string): string | undefined => {
	const cleaned = value.trim().replace(/^scm:git:/i, '').replace(/^scm:/i, '');
	const url = normalizeRepoUrl(cleaned);
	return url && isRepoRootUrl(url, cleaned) ? url : undefined;
};

/**
 * A POM names its source in `<scm>`. developerConnection is the clone URL, connection is often the
 * read-only clone, and `<url>` is sometimes a browsable page; try them in that order, then the
 * project url, and let the repo-root test drop a project site.
 */
export function reposFromPom(xml: string): RepoRef[] {
	const scm = /<scm>([\s\S]*?)<\/scm>/i.exec(xml)?.[1];
	const refs: RepoRef[] = [];
	const push = (raw: string | undefined) => {
		if (!raw) return;
		const url = scmRepo(raw);
		if (!url || refs.some((existing) => existing.url === url)) return;
		refs.push(makeRef(url, 'maven-pom'));
	};
	if (scm) {
		push(/<developerConnection>\s*([^<]+?)\s*<\/developerConnection>/i.exec(scm)?.[1]);
		push(/<connection>\s*([^<]+?)\s*<\/connection>/i.exec(scm)?.[1]);
		push(/<url>\s*([^<]+?)\s*<\/url>/i.exec(scm)?.[1]);
	}
	push(/<url>\s*([^<]+?)\s*<\/url>/i.exec(xml)?.[1]);
	return refs;
}

/** The version list from the NuGet flat-container index. */
export function parseNugetVersions(document: unknown): string[] {
	const versions = asRecord(document)?.versions;
	return Array.isArray(versions) ? versions.map(asString).filter((entry): entry is string => Boolean(entry)) : [];
}

/** A .nuspec names its source in `<repository url>`; modern packages publish it. */
export function reposFromNuspec(xml: string): RepoRef[] {
	const raw = /<repository\b[^>]*\burl=["']([^"']+)["']/i.exec(xml)?.[1];
	const url = normalizeRepoUrl(raw);
	if (!url || !isRepoRootUrl(url, raw)) return [];
	return [makeRef(url, 'nuget-nuspec')];
}

/**
 * zpm is the community Zig package index. It lists git repos, not releases, so a version only
 * reaches the ref stage: tag candidates are verified against git like every other source.
 */
export type ZigMatch = { author: string; name: string; repos: RepoRef[] };

export function zigMatches(payload: unknown, name: string): ZigMatch[] {
	if (!Array.isArray(payload)) return [];
	const wanted = name.trim().toLowerCase();
	const slash = wanted.indexOf('/');
	const wantedAuthor = slash > 0 ? wanted.slice(0, slash) : undefined;
	const wantedName = slash > 0 ? wanted.slice(slash + 1) : wanted;
	const matches: ZigMatch[] = [];
	for (const item of payload) {
		const record = asRecord(item);
		const author = asString(record?.author) ?? '';
		const packageName = asString(record?.name) ?? '';
		if (!packageName || packageName.toLowerCase() !== wantedName) continue;
		if (wantedAuthor && author.toLowerCase() !== wantedAuthor) continue;
		const links = asRecord(record?.links);
		const refs: RepoRef[] = [];
		for (const value of [record?.git, links?.github, links?.gitlab]) {
			const url = normalizeRepoUrl(value);
			if (!url || !isRepoRootUrl(url, value)) continue;
			if (refs.some((existing) => existing.url === url)) continue;
			refs.push(makeRef(url, 'zpm-index'));
		}
		matches.push({ author, name: packageName, repos: refs });
	}
	return matches;
}

/**
 * Tag names worth trying for a published version, most likely first. Registries do not publish
 * git tags, so these are guesses that git then confirms or rejects.
 */
export function refCandidates(source: PackageSource, name: string, version: string | null): string[] {
	if (!version) return [];
	const candidates: string[] = [];
	const push = (value: string) => {
		if (value && !candidates.includes(value)) candidates.push(value);
	};
	switch (source) {
		case 'npm':
			push('v' + version);
			push(version);
			push(name + '@' + version);
			break;
		case 'jsr':
			push(version);
			push('v' + version);
			push(name + '@' + version);
			break;
		case 'crate':
			push('v' + version);
			push(version);
			push(name + '-v' + version);
			push(name + '-' + version);
			break;
		case 'pypi':
			push('v' + version);
			push(version);
			push(name + '-' + version);
			break;
		case 'go':
			push('v' + version);
			push(version);
			break;
		case 'hex':
			push('v' + version);
			push(version);
			push(name + '-v' + version);
			break;
		case 'maven': {
			const artifact = name.split(':')[1] ?? name;
			push('v' + version);
			push(version);
			push(artifact + '-v' + version);
			push(artifact + '-' + version);
			push('rel/' + artifact + '-' + version);
			// A classifier (guava's -jre, -android) is not part of the tag: v33.3.1 serves both.
			const base = version.replace(/-(?:jre|android)$/i, '');
			if (base !== version) {
				push('v' + base);
				push(base);
				push(artifact + '-v' + base);
				push(artifact + '-' + base);
				push('rel/' + artifact + '-' + base);
			}
			break;
		}
		case 'nuget':
			push('v' + version);
			push(version);
			push(name + '-v' + version);
			break;
		case 'zig':
			push('v' + version);
			push(version);
			break;
		case 'dockerhub':
			// A Docker tag names an image, not a git revision: there is nothing to clone at.
			break;
	}
	return candidates;
}

export type RemoteRefs = { tags: string[]; branches: string[] };

/** What resolvePackageRepo needs from the outside world. */
export type RegistryDeps = {
	fetchJson: (url: string, headers?: Record<string, string>) => Promise<unknown>;
	fetchText: (url: string) => Promise<string>;
	lsRemote: (url: string) => Promise<RemoteRefs>;
};

const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = 'repo-scout (+pi)';

const fetchWithTimeout = async (url: string, headers: Record<string, string>, accept: string): Promise<string> => {
	const response = await fetch(url, {
		headers: { accept, 'user-agent': USER_AGENT, ...headers },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error('GET ' + url + ' -> ' + response.status + ' ' + response.statusText);
	return response.text();
};

const gitLsRemote = async (url: string): Promise<RemoteRefs> => {
	const { stdout } = await promisify(execFile)('git', ['ls-remote', '--tags', '--heads', url], {
		timeout: 20_000,
		maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	});
	const tags: string[] = [];
	const branches: string[] = [];
	for (const line of stdout.split('\n')) {
		const at = line.indexOf('\t');
		if (at < 0) continue;
		const name = line.slice(at + 1).trim();
		if (name.startsWith('refs/tags/')) tags.push(name.slice('refs/tags/'.length));
		else if (name.startsWith('refs/heads/')) branches.push(name.slice('refs/heads/'.length));
	}
	return { tags, branches };
};

export const liveRegistryDeps: RegistryDeps = {
	fetchJson: async (url, headers = {}) => JSON.parse(await fetchWithTimeout(url, headers, 'application/json')),
	fetchText: async (url) => fetchWithTimeout(url, {}, 'text/plain, application/json'),
	lsRemote: gitLsRemote,
};

/** Match the first candidate against the tags, then the branches, of the repo. */
export function matchRef(candidates: string[], remotes: RemoteRefs): { ref: string; refKind: RefKind } | null {
	for (const candidate of candidates) {
		if (remotes.tags.includes(candidate)) return { ref: candidate, refKind: 'tag' };
	}
	for (const candidate of candidates) {
		if (remotes.branches.includes(candidate)) return { ref: candidate, refKind: 'branch' };
	}
	return null;
}

/** npm: packument -> version manifest -> repository, else tarball. */
export function parseNpm(packument: unknown, version?: string): { version: string | null; repos: RepoRef[]; warnings: string[] } {
	const warnings: string[] = [];
	const resolved = version ?? npmVersion(packument) ?? null;
	const manifest = npmManifest(packument, version);
	if (!manifest) throw new Error('npm manifest was not an object');
	const known = Object.keys(asRecord(asRecord(packument)?.versions) ?? {});
	if (version && known.length > 0 && !known.includes(version)) {
		warnings.push('no npm release ' + version + '; the fields may describe another release');
	}
	const stated = reposFromManifest(manifest);
	if (stated.length) return { version: resolved, repos: stated, warnings };
	const ignored = ignoredRepository(manifest.repository) ?? ignoredRepository(manifest.homepage);
	if (ignored) warnings.push('ignored ' + ignored + ': not a cloneable https git host');
	const tarball = tarballFromNpmManifest(manifest);
	if (tarball) {
		warnings.push('npm manifest names no repository; only the tarball is known');
		return { version: resolved, repos: [tarball], warnings };
	}
	warnings.push('no repository in the npm manifest');
	return { version: resolved, repos: [], warnings };
}

/** JSR meta.json: the latest version and every published one. */
export function parseJsrMeta(meta: unknown): { latest: string | null; versions: string[] } {
	const record = asRecord(meta);
	return { latest: asString(record?.latest) ?? null, versions: Object.keys(asRecord(record?.versions) ?? {}) };
}

/** The version the caller asked for, or the registry latest. */
export function pickVersion(requested: string | undefined, latest: string | null, available: string[]): string | null {
	return requested ?? latest ?? available[0] ?? null;
}

const githubSearch = async (name: string, deps: RegistryDeps, warnings: string[]): Promise<RepoRef[]> => {
	const bare = name.replace(/^@[^/]+\//, '');
	const query = encodeURIComponent(bare + ' in:name');
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	try {
		const payload = await deps.fetchJson(
			'https://api.github.com/search/repositories?q=' + query + '&per_page=5',
			token ? { authorization: 'Bearer ' + token } : {},
		);
		return reposFromGithubSearch(payload).slice(0, 3);
	} catch (error) {
		warnings.push('GitHub search failed: ' + (error instanceof Error ? error.message : String(error)));
		return [];
	}
};

/** Read one source into version + repos, before any ref is resolved. */
const discover = async (
	input: { package: string; source: PackageSource; version?: string },
	deps: RegistryDeps,
): Promise<{ version: string | null; repos: RepoRef[]; warnings: string[]; refHints?: string[] }> => {
	const name = input.package.trim();
	const warnings: string[] = [];

	switch (input.source) {
		case 'npm': {
			const packument = await deps.fetchJson('https://registry.npmjs.org/' + npmPath(name));
			return parseNpm(packument, input.version);
		}

		case 'jsr': {
			if (!/^@[^/]+\/[^/]+$/.test(name)) throw new Error('jsr package must be @scope/name: ' + name);
			// JSR keeps the @ in its URLs: https://jsr.io/@std/path/meta.json
			const path = name;
			const meta = await deps.fetchJson('https://jsr.io/' + path + '/meta.json');
			const { latest, versions } = parseJsrMeta(meta);
			const version = pickVersion(input.version, latest, versions);
			warnMissingVersion('jsr', input.version, versions, warnings);
			if (!version) throw new Error('jsr reported no versions for ' + name);
			let repos: RepoRef[] = [];
			let deno: unknown;
			try {
				deno = JSON.parse(await deps.fetchText('https://jsr.io/' + path + '/' + encodeURIComponent(version) + '/deno.json'));
				repos = reposFromJsrDenoJson(deno);
			} catch (error) {
				warnings.push('could not read the jsr deno.json: ' + (error instanceof Error ? error.message : String(error)));
			}
			const ignored = ignoredRepository(asRecord(deno)?.repository);
			if (ignored) warnings.push('ignored ' + ignored + ': not a cloneable https git host');
			if (!repos.length) {
				warnings.push('jsr deno.json names no githubRepository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'crate': {
			const crate = asRecord(await deps.fetchJson('https://crates.io/api/v1/crates/' + encodeURIComponent(name)));
			const info = asRecord(crate?.crate);
			if (!info) throw new Error('crates.io returned no crate for ' + name);
			const version = pickVersion(input.version, asString(info.max_version) ?? null, []);
			const known = Array.isArray(crate?.versions)
				? crate.versions.map((entry) => asString(asRecord(entry)?.num)).filter((entry): entry is string => Boolean(entry))
				: [];
			warnMissingVersion('crate', input.version, known, warnings);
			let repos = reposFromManifest({ repository: info.repository, homepage: info.homepage });
			if (!repos.length) {
				warnings.push('crates.io names no repository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'pypi': {
			const project = asRecord(await deps.fetchJson('https://pypi.org/pypi/' + encodeURIComponent(name) + '/json'));
			const info = asRecord(project?.info);
			if (!info) throw new Error('PyPI returned no info for ' + name);
			const version = pickVersion(input.version, asString(info.version) ?? null, []);
			warnMissingVersion('pypi', input.version, Object.keys(asRecord(project?.releases) ?? {}), warnings);
			let repos = reposFromPypi(info);
			if (!repos.length) {
				warnings.push('PyPI project_urls name no repository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'go': {
			if (!isGoModulePath(name)) {
				throw new Error('go package must be a module path: github.com/owner/name or gopkg.in/name.vN');
			}
			const modulePath = escapeGoModule(name);
			const base = 'https://proxy.golang.org/' + modulePath;
			let info: unknown;
			if (input.version) {
				try {
					info = await deps.fetchJson(base + '/@v/' + encodeURIComponent(input.version) + '.info');
				} catch {
					warnings.push('no go release ' + input.version + '; the fields may describe another release');
					info = await deps.fetchJson(base + '/@latest');
				}
			} else {
				info = await deps.fetchJson(base + '/@latest');
			}
			const parsed = parseGoVersionInfo(info);
			const version = input.version ?? parsed.version;
			const proxyOrigin =
				parsed.repo && (!parsed.vcs || parsed.vcs === 'git') && isPublicGitHost(new URL(parsed.repo).hostname)
					? parsed.repo
					: undefined;
			let repoUrl = proxyOrigin;
			const ignored = parsed.repo && !repoUrl ? parsed.repo : undefined;
			if (ignored) warnings.push('ignored ' + ignored + ': not a cloneable https git host');
			if (!repoUrl && isRepoRootUrl('https://' + name)) repoUrl = 'https://' + name;
			let via: RepoVia = 'go-proxy-origin';
			if (!repoUrl) {
				// A vanity path (golang.org/x/text, gopkg.in/...) serves its repo in a go-import meta tag.
				try {
					const fromMeta = goImportRepo(await deps.fetchText('https://' + name + '?go-get=1'));
					if (fromMeta && isRepoRootUrl(fromMeta)) {
						repoUrl = fromMeta;
						via = 'go-import-meta';
					}
				} catch (error) {
					warnings.push('could not resolve the go-import meta tag: ' + messageOf(error));
				}
			}
			let repos = repoUrl ? [makeRef(repoUrl, via)] : [];
			if (!repos.length) {
				warnings.push('the go proxy named no source repository');
				repos = await githubSearch(name.split('/').pop() ?? name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'hex': {
			if (!/^[a-z0-9_]+$/i.test(name)) throw new Error('hex package must be a name like phoenix or ecto_sql');
			const payload = await deps.fetchJson('https://hex.pm/api/packages/' + encodeURIComponent(name));
			const parsed = parseHexPackage(payload);
			const version = pickVersion(input.version, parsed.latest, parsed.versions);
			warnMissingVersion('hex', input.version, parsed.versions, warnings);
			let repos = parsed.repos;
			if (!repos.length) {
				warnings.push('the hex package links no repository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'maven': {
			const coordinates = name.split(':');
			if (coordinates.length !== 2 || !coordinates.every((part) => /^[A-Za-z0-9_.-]+$/.test(part))) {
				throw new Error('maven package must be group:artifact, e.g. com.google.guava:guava: ' + name);
			}
			const [group, artifact] = coordinates as [string, string];
			const base =
				'https://repo1.maven.org/maven2/' +
				group.split('.').map(encodeURIComponent).join('/') +
				'/' +
				encodeURIComponent(artifact);
			const metadata = parseMavenMetadata(await deps.fetchText(base + '/maven-metadata.xml'));
			const version = pickVersion(
				input.version,
				metadata.release ?? metadata.latest ?? metadata.versions.at(-1) ?? null,
				metadata.versions,
			);
			warnMissingVersion('maven', input.version, metadata.versions, warnings);
			// A requested version that the directory does not list falls back to the release's POM.
			const pomVersion = version && metadata.versions.includes(version) ? version : (metadata.release ?? version);
			let repos: RepoRef[] = [];
			let refHints: string[] = [];
			if (pomVersion) {
				try {
					const pom = await deps.fetchText(
						base + '/' + encodeURIComponent(pomVersion) + '/' + encodeURIComponent(artifact + '-' + pomVersion) + '.pom',
					);
					repos = reposFromPom(pom);
					const tag = pomTag(pom);
					if (tag) refHints = [tag];
					if (!repos.length) {
						const raw = /<url>\s*([^<]+?)\s*<\/url>/i.exec(pom)?.[1];
						const url = raw ? normalizeRepoUrl(raw) : undefined;
						if (url && !isRepoRootUrl(url, raw)) {
							warnings.push('ignored ' + url + ': not a cloneable https git host');
						}
						warnings.push('the pom names no repository');
					}
				} catch (error) {
					warnings.push('could not read the pom: ' + messageOf(error));
				}
			}
			if (!repos.length) repos = await githubSearch(artifact, deps, warnings);
			return { version, repos, warnings, refHints };
		}

		case 'nuget': {
			if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('nuget package must be an id like Newtonsoft.Json');
			const id = name.toLowerCase();
			const base = 'https://api.nuget.org/v3-flatcontainer/' + encodeURIComponent(id);
			const versions = parseNugetVersions(await deps.fetchJson(base + '/index.json'));
			const version = pickVersion(input.version, versions.at(-1) ?? null, versions);
			warnMissingVersion('nuget', input.version, versions, warnings);
			const nuspecVersion = version && versions.includes(version) ? version : versions.at(-1);
			let repos: RepoRef[] = [];
			if (nuspecVersion) {
				try {
					const nuspec = await deps.fetchText(
						base + '/' + encodeURIComponent(nuspecVersion) + '/' + encodeURIComponent(id) + '.nuspec',
					);
					repos = reposFromNuspec(nuspec);
					if (!repos.length) {
						const raw = /<repository\b[^>]*\burl=["']([^"']+)["']/i.exec(nuspec)?.[1];
						const url = raw ? normalizeRepoUrl(raw) : undefined;
						if (url && !isRepoRootUrl(url, raw)) {
							warnings.push('ignored ' + url + ': not a cloneable https git host');
						}
						warnings.push('the nuspec names no repository');
					}
				} catch (error) {
					warnings.push('could not read the nuspec: ' + messageOf(error));
				}
			}
			if (!repos.length) repos = await githubSearch(name, deps, warnings);
			return { version, repos, warnings };
		}

		case 'zig': {
			if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(name)) {
				throw new Error('zig package must be name or author/name, e.g. accord or BanchouBoo/accord');
			}
			const zpm = await deps.fetchJson('https://zig.pm/api/packages');
			const matches = zigMatches(zpm, name);
			if (matches.length > 1) {
				warnings.push('zpm lists ' + matches.length + ' packages named ' + name + '; pass author/name to choose one');
			}
			if (input.version) {
				warnings.push(
					'zpm lists git repos, not releases: ' + input.version + ' is checked against git tags only',
				);
			}
			const repos = matches.flatMap((match) => match.repos);
			const unique = repos.filter((repo, index) => repos.findIndex((other) => other.url === repo.url) === index);
			if (!unique.length) {
				warnings.push('zpm lists no package named ' + name);
			}
			return {
				version: input.version ?? null,
				repos: unique.length ? unique : await githubSearch(name.split('/').pop() ?? name, deps, warnings),
				warnings,
			};
		}

		case 'dockerhub': {
			if (!/^[\w.-]+\/[\w.-]+$/.test(name)) throw new Error('dockerhub image must be owner/name: ' + name);
			const image = await deps.fetchJson('https://hub.docker.com/v2/repositories/' + name + '/');
			const version = input.version ?? null;
			if (version) {
				try {
					await deps.fetchJson('https://hub.docker.com/v2/repositories/' + name + '/tags/' + encodeURIComponent(version));
				} catch {
					warnings.push('Docker Hub has no tag ' + version + ' for ' + name);
				}
			}
			warnings.push('a Docker tag names an image, not a git revision: no ref is derived from it');
			let repos = reposFromDockerhubHub(image);
			if (!repos.length) {
				warnings.push('the Docker Hub description links no repository');
				repos = await githubSearch(name.split('/').pop() ?? name, deps, warnings);
			}
			return { version, repos, warnings };
		}
	}
};

const withRefs = async (repos: RepoRef[], candidates: string[], deps: RegistryDeps, warnings: string[]): Promise<RepoRef[]> => {
	const results = await Promise.all(
		repos.map(async (repo) => {
			const notes: string[] = [];
			if (repo.kind !== 'repository' || candidates.length === 0) return { repo: { ...repo, refCandidates: candidates }, notes };
			try {
				const remotes = await deps.lsRemote(repo.url);
				const match = matchRef(candidates, remotes);
				if (!match) notes.push('no tag matched on ' + repo.url + '; tried ' + candidates.join(', '));
				return { repo: { ...repo, ref: match?.ref ?? null, refKind: match?.refKind ?? null, refCandidates: candidates }, notes };
			} catch (error) {
				notes.push('could not list refs on ' + repo.url + ': ' + (error instanceof Error ? error.message : String(error)));
				return { repo: { ...repo, refCandidates: candidates }, notes };
			}
		}),
	);
	for (const result of results) warnings.push(...result.notes);
	return results.map((result) => result.repo);
};

/**
 * Resolve a package to the repos that serve it and the ref that serves the requested version.
 *
 * The repos and the version come from the registry. The ref does not: registries publish versions,
 * not git tags, so candidate tags are tried against the repo and only a confirmed one is reported.
 * When nothing matches, the candidates travel with the result so a caller can probe.
 */
export async function resolvePackageRepo(
	input: { package: string; source?: PackageSource; version?: string },
	deps: RegistryDeps = liveRegistryDeps,
): Promise<PackageRepoResult> {
	const name = input.package.trim();
	if (!name) throw new Error('package is empty');
	const version = versionOf(input.version);
	const source = input.source ?? 'npm';
	if (!PACKAGE_SOURCES.includes(source)) {
		throw new Error('unknown source: ' + String(source) + '. Supported: ' + PACKAGE_SOURCES.join(', ') + '.');
	}

	const discovered = await discover({ package: name, source, version }, deps);
	const warnings = [...discovered.warnings];
	// A ref the metadata declared (a POM's scm tag) is tried before guessed tag names.
	const candidates = [...new Set([...(discovered.refHints ?? []), ...refCandidates(source, name, discovered.version)])];
	const repos = await withRefs(discovered.repos, candidates, deps, warnings);
	if (repos.length > 0 && !repos.some((repo) => repo.kind === 'repository' && repo.confidence === 'stated')) {
		warnings.push('no stated repository: every URL here is a name-search guess, so verify it before reading');
	}
	return { package: name, source, version: discovered.version, repos, warnings };
}

/**
 * The clone target for a result: the first repository the publisher stated.
 *
 * A name-search guess is never a target. Pointing a scout at the wrong repo is worse than pointing it
 * nowhere, because the report comes back confident and about the wrong code.
 */
export function cloneTarget(result: PackageRepoResult): { url: string; ref: string | null } | null {
	const repo = result.repos.find(
		(candidate) => candidate.kind === 'repository' && candidate.confidence === 'stated',
	);
	return repo ? { url: repo.url, ref: repo.ref } : null;
}