/**
 * Package name -> git repo URLs.
 *
 * "Which repo serves this package" is a provenance question, so the answer carries where it came
 * from and how much to trust it. A manifest's own `repository` field is provenance; a GitHub
 * name search is a guess, and it says so.
 *
 * The parsing is pure (exported parsers, fixture-tested). The fetches are the only network in this
 * file, and they are reached only through `resolvePackageRepo`.
 */

/** Registries this tool knows how to read. */
export const REGISTRIES = ["npm", "jsr"] as const;
export type Registry = (typeof REGISTRIES)[number];

export type RepoKind = "repository" | "tarball";
/** `stated`: the package's own manifest names it. `guess`: a name search matched it. */
export type Confidence = "stated" | "guess";
export type RepoSource = "manifest" | "npm-tarball" | "github-search" | "jsr-meta";

export type RepoRef = {
	/** A git URL ready for `repo_scout`. */
	url: string;
	/** `repository` is browsable code; `tarball` is provenance only. */
	kind: RepoKind;
	source: RepoSource;
	confidence: Confidence;
};

export type PackageRepoResult = {
	package: string;
	registry: Registry;
	version?: string;
	repos: RepoRef[];
	warnings: string[];
};

/** Shape of the fields we read off any registry document. Loose on purpose: registries evolve. */
export type Manifest = {
	homepage?: unknown;
	repository?: unknown;
	bugs?: unknown;
	dist?: unknown;
	githubRepository?: unknown;
};

/** Hosts where /owner/name is a repo and anything deeper is a page inside one. */
const FORGE_HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org", "bitbucket.org", "gitea.com"]);

/**
 * Repo names that are really site routes. A GitHub repo can be called `issues`, so this only rules out
 * the well-known routes a forge reserves and a package would point at by mistake.
 */
const SITE_ROUTES = new Set(["issues", "pulls", "releases", "wiki", "actions", "settings", "security", "blob", "tree"]);

const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/**
 * Normalize a manifest repo reference to a clone URL. Handles the shapes registries actually emit:
 * a string, `{ type, url }`, `git+https://...`, `git://...`, `github:owner/name`,
 * `owner/name`, and a `git+ssh://git@host/...` URL. Returns undefined for anything else.
 */
export function normalizeRepoUrl(value: unknown): string | undefined {
	let raw: string | undefined;
	if (typeof value === "string") raw = value.trim();
	else if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		raw = asString(record.url) ?? asString(record.repository);
	}
	if (!raw) return undefined;

	const short = /^github:([\w.-]+\/[\w.-]+)$/i.exec(raw);
	if (short) return `https://github.com/${short[1]}`;

	const bare = /^([\w.-]+\/[\w.-]+)(?:#.*)?$/.exec(raw);
	if (bare && !raw.includes("://")) return `https://github.com/${bare[1]}`;

	let url = raw
		.replace(/^git\+/, "")
		.replace(/^git:\/\//, "https://")
		.replace(/^ssh:\/\/(?:[^@/]+@)?/, "https://")
		.replace(/^git@([^:]+):/, "https://$1/");
	url = url.replace(/#.*$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(url)) return undefined;
	return url;
}

/**
 * Is this URL a repo root rather than a page inside one or beside it? A homepage (zod.dev) or a bugs
 * page (github.com/o/n/issues) is useful provenance but cannot be cloned, so it is not a repo URL.
 */
export const isRepoRootUrl = (url: string): boolean => {
	let parts: string[];
	try {
		parts = new URL(url).pathname.split("/").filter(Boolean);
	} catch {
		return false;
	}
	const host = new URL(url).hostname.toLowerCase();
	if (FORGE_HOSTS.has(host)) {
		// A forge URL is a repo root only when its path is exactly owner/name.
		return parts.length === 2 && !SITE_ROUTES.has((parts[1] ?? "").toLowerCase());
	}
	return parts.length >= 2;
};

/** Git URLs out of a manifest: the repository field first, then a homepage that is itself a repo. */
export function reposFromManifest(manifest: Manifest): RepoRef[] {
	const refs: RepoRef[] = [];
	const push = (value: unknown, requireRepoRoot = false) => {
		const url = normalizeRepoUrl(value);
		if (!url) return;
		if (requireRepoRoot && !isRepoRootUrl(url)) return;
		if (refs.some((ref) => ref.url === url)) return;
		refs.push({ url, kind: "repository", source: "manifest", confidence: "stated" });
	};
	push(manifest.repository);
	push(manifest.githubRepository);
	// A homepage can be the repo, but bugs and a docs site cannot: they carry a route, not a repo.
	push(manifest.bugs, true);
	push(manifest.homepage, true);
	return refs;
}

/** The npm tarball, which proves provenance but is not browsable. */
export function tarballFromNpmManifest(manifest: Manifest): RepoRef | undefined {
	const dist = manifest.dist;
	if (!dist || typeof dist !== "object") return undefined;
	const tarball = asString((dist as Record<string, unknown>).tarball);
	if (!tarball) return undefined;
	return { url: tarball, kind: "tarball", source: "npm-tarball", confidence: "stated" };
}

/** GitHub search hits, mapped to repositories. Always `guess`: a name match is not provenance. */
export function reposFromGithubSearch(payload: unknown): RepoRef[] {
	if (!payload || typeof payload !== "object") return [];
	const items = (payload as Record<string, unknown>).items;
	if (!Array.isArray(items)) return [];
	const refs: RepoRef[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const url = normalizeRepoUrl(record.html_url);
		if (!url || refs.some((ref) => ref.url === url)) continue;
		refs.push({ url, kind: "repository", source: "github-search", confidence: "guess" });
	}
	return refs;
}

/** The latest version an npm packument points at. */
export function npmVersion(packument: unknown): string | undefined {
	if (!packument || typeof packument !== "object") return undefined;
	const tags = (packument as Record<string, unknown>)["dist-tags"];
	if (!tags || typeof tags !== "object") return undefined;
	return asString((tags as Record<string, unknown>).latest);
}

/**
 * The manifest for the latest version, falling back to the packument root, which carries the same
 * fields at the top level for older publishes.
 */
export function npmManifest(packument: unknown): Manifest | undefined {
	if (!packument || typeof packument !== "object") return undefined;
	const record = packument as Record<string, unknown>;
	const version = npmVersion(packument);
	const versions = record.versions;
	if (version && versions && typeof versions === "object") {
		const entry = (versions as Record<string, unknown>)[version];
		if (entry && typeof entry === "object") return entry as Manifest;
	}
	return record as Manifest;
}

/** Merge first-wins across steps: provenance (stated) first, guesses last, deduped by URL. */
export function mergeRepos(...groups: RepoRef[][]): RepoRef[] {
	const merged: RepoRef[] = [];
	for (const group of groups) {
		for (const ref of group) {
			if (merged.some((existing) => existing.url === ref.url)) continue;
			merged.push(ref);
		}
	}
	return merged;
}

const FETCH_TIMEOUT_MS = 15_000;

const fetchJson = async (url: string, headers: Record<string, string> = {}): Promise<unknown> => {
	const response = await fetch(url, {
		headers: { accept: "application/json", "user-agent": "repo-scout (+pi)", ...headers },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
	return response.json();
};

/** Split `@scope/name` into its scope and bare name, for the npm endpoint. */
export function npmPackageUrl(name: string): string {
	return `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
}

export function jsrMetaUrl(name: string): string | undefined {
	const parts = name.replace(/^@/, "").split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
	return `https://jsr.io/@${parts[0]}/${parts[1]}/meta.json`;
}

/**
 * Resolve `package` to git repos. Steps run in provenance order and stop contributing once a stated
 * repository is found; the GitHub search only runs when nothing stated was found.
 */
export async function resolvePackageRepo(input: {
	package: string;
	registry: Registry;
}): Promise<PackageRepoResult> {
	const warnings: string[] = [];
	const name = input.package.trim();
	if (!name) throw new Error("package is empty");

	if (input.registry === "jsr") {
		const url = jsrMetaUrl(name);
		if (!url) throw new Error(`jsr package must be @scope/name: ${name}`);
		const meta = (await fetchJson(url)) as Manifest & { latest?: unknown };
		const repos = reposFromManifest(meta).map((ref) => ({ ...ref, source: "jsr-meta" as const }));
		const version = asString(meta.latest);
		if (repos.length === 0) warnings.push("jsr meta.json names no repository");
		return { package: name, registry: "jsr", version, repos: repos.length ? repos : await githubSearch(name, warnings), warnings };
	}

	const packument = await fetchJson(npmPackageUrl(name));
	const version = npmVersion(packument);
	const manifest = npmManifest(packument);
	if (!manifest) throw new Error(`npm manifest for ${name} was not an object`);

	const stated = reposFromManifest(manifest);
	if (stated.length > 0) {
		return { package: name, registry: "npm", version, repos: stated, warnings };
	}

	const tarball = tarballFromNpmManifest(manifest);
	if (tarball) {
		return {
			package: name,
			registry: "npm",
			version,
			repos: [tarball],
			warnings: [...warnings, "npm manifest names no repository; only the tarball is known"],
		};
	}

	const guesses = await githubSearch(name, warnings);
	return {
		package: name,
		registry: "npm",
		version,
		repos: guesses,
		warnings: [...warnings, guesses.length ? "no repository in the manifest; these are name-search guesses" : "no repository found"],
	};
}

const githubSearch = async (name: string, warnings: string[]): Promise<RepoRef[]> => {
	const bare = name.replace(/^@[^/]+\//, "").replace(/^jsr:@[^/]+\//, "");
	const query = encodeURIComponent(`${bare} in:name`);
	const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	try {
		const payload = await fetchJson(`https://api.github.com/search/repositories?q=${query}&per_page=5`, token ? { authorization: `Bearer ${token}` } : {});
		return reposFromGithubSearch(payload).slice(0, 3);
	} catch (error) {
		warnings.push(`GitHub search failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
};
