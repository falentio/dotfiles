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

export const PACKAGE_SOURCES = ['npm', 'jsr', 'crate', 'pypi', 'dockerhub'] as const;

/** A package registry this tool can read. */
export type PackageSource = (typeof PACKAGE_SOURCES)[number];

/** repository: browsable code. tarball: provenance only, not a git repo. */
export type RepoKind = 'repository' | 'tarball';

/** stated: the publisher said it. guess: a name search matched it. */
export type Confidence = 'stated' | 'guess';

/** Which field the URL came out of, so a reader can judge it. */
export type RepoVia = 'manifest' | 'npm-tarball' | 'jsr-deno-json' | 'pypi-project-urls' | 'dockerhub-description' | 'github-search';

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

/**
 * Is this URL a repo root rather than a page inside one, or beside it? A homepage (zod.dev) or a
 * bugs page (github.com/o/n/issues) is provenance but cannot be cloned.
 */
export function isRepoRootUrl(url: string, raw?: unknown): boolean {
	// A URL the publisher wrote with a .git suffix is a git URL by construction, whatever the host.
	const original = asString(raw);
	if (original && /\.git([#?].*)?$/i.test(original)) return true;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (!isForgeHost(parsed.hostname)) return false;
	const parts = parsed.pathname.split('/').filter(Boolean);
	return parts.length === 2 && !SITE_ROUTES.has((parts[1] ?? '').toLowerCase());
}

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

/** First-wins merge, deduped by URL. */
export function mergeRepos(...groups: RepoRef[][]): RepoRef[] {
	const merged: RepoRef[] = [];
	for (const group of groups) {
		for (const candidate of group) {
			if (merged.some((existing) => existing.url === candidate.url)) continue;
			merged.push(candidate);
		}
	}
	return merged;
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
		timeout: 60_000,
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
	if (version && npmVersion(packument) && !asRecord(asRecord(packument)?.versions)?.[version]) {
		warnings.push('npm has no version ' + version + '; the fields may describe another release');
	}
	const stated = reposFromManifest(manifest);
	if (stated.length) return { version: resolved, repos: stated, warnings };
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
): Promise<{ version: string | null; repos: RepoRef[]; warnings: string[] }> => {
	const name = input.package.trim();
	const warnings: string[] = [];

	switch (input.source) {
		case 'npm': {
			const packument = await deps.fetchJson('https://registry.npmjs.org/' + name.replace('/', '%2F'));
			return parseNpm(packument, input.version);
		}

		case 'jsr': {
			if (!/^@[^/]+\/[^/]+$/.test(name)) throw new Error('jsr package must be @scope/name: ' + name);
			// JSR keeps the @ in its URLs: https://jsr.io/@std/path/meta.json
			const path = name;
			const meta = await deps.fetchJson('https://jsr.io/' + path + '/meta.json');
			const { latest, versions } = parseJsrMeta(meta);
			const version = pickVersion(input.version, latest, versions);
			if (!version) throw new Error('jsr reported no versions for ' + name);
			let repos: RepoRef[] = [];
			try {
				const denoJson = await deps.fetchText('https://jsr.io/' + path + '/' + version + '/deno.json');
				repos = reposFromJsrDenoJson(JSON.parse(denoJson));
			} catch (error) {
				warnings.push('could not read the jsr deno.json: ' + (error instanceof Error ? error.message : String(error)));
			}
			if (!repos.length) {
				warnings.push('jsr deno.json names no githubRepository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'crate': {
			const crate = asRecord(await deps.fetchJson('https://crates.io/api/v1/crates/' + name));
			const info = asRecord(crate?.crate);
			if (!info) throw new Error('crates.io returned no crate for ' + name);
			const version = pickVersion(input.version, asString(info.max_version) ?? null, []);
			let repos = reposFromManifest({ repository: info.repository, homepage: info.homepage });
			if (!repos.length) {
				warnings.push('crates.io names no repository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
		}

		case 'pypi': {
			const project = asRecord(await deps.fetchJson('https://pypi.org/pypi/' + name + '/json'));
			const info = asRecord(project?.info);
			if (!info) throw new Error('PyPI returned no info for ' + name);
			const version = pickVersion(input.version, asString(info.version) ?? null, []);
			let repos = reposFromPypi(info);
			if (!repos.length) {
				warnings.push('PyPI project_urls name no repository');
				repos = await githubSearch(name, deps, warnings);
			}
			return { version, repos, warnings };
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
	const out: RepoRef[] = [];
	for (const repo of repos) {
		if (repo.kind !== 'repository' || candidates.length === 0) {
			out.push({ ...repo, refCandidates: candidates });
			continue;
		}
		try {
			const remotes = await deps.lsRemote(repo.url);
			const match = matchRef(candidates, remotes);
			if (!match) warnings.push('no tag matched on ' + repo.url + '; tried ' + candidates.join(', '));
			out.push({ ...repo, ref: match?.ref ?? null, refKind: match?.refKind ?? null, refCandidates: candidates });
		} catch (error) {
			warnings.push('could not list refs on ' + repo.url + ': ' + (error instanceof Error ? error.message : String(error)));
			out.push({ ...repo, refCandidates: candidates });
		}
	}
	return out;
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
	const source = input.source ?? 'npm';
	if (!PACKAGE_SOURCES.includes(source)) {
		throw new Error('unknown source: ' + String(source) + '. Supported: ' + PACKAGE_SOURCES.join(', ') + '.');
	}

	const discovered = await discover({ package: name, source, version: input.version }, deps);
	const warnings = [...discovered.warnings];
	const candidates = refCandidates(source, name, discovered.version);
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