/**
 * Repo identity: every accepted spelling of a repo becomes one canonical key.
 *
 * The key is what makes "one session per repo" real. A worktree, the main checkout, the https URL and
 * the scp-style URL all have to land on the same string, or the caller pays for a fresh crawl each
 * time. Anything that cannot be recognized throws rather than guessing, because a wrong key means a
 * session that answers about the wrong code.
 */

/** A resolved repo: the canonical key, plus how to get a checkout of the code. */
export type RepoIdentity = {
	/** Canonical identity, e.g. "github.com/owner/name" or "local:/abs/path". */
	key: string;
	/** Where to clone from: a git URL for remotes, an absolute path for local repos. */
	source: string;
	/** Human-facing form for reports. */
	display: string;
	kind: "remote" | "local";
	/** Path component safe to use as a directory name. */
	slug: string;
};

const GIT_SUFFIX = /\.git$/i;
const SCP_STYLE = /^(?:[\w.-]+@)?([\w.-]+\.[a-z]{2,}):(?!\d+$)(.+)$/i;
const HOSTISH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i;
const OWNER_NAME = /^[\w.-]+\/[\w.-]+(?:\.git)?$/;
/** Forge routes that sit inside a repo: /tree/<ref>/..., /blob/..., /issues. */
const ROUTE_WORDS = new Set([
	"tree",
	"blob",
	"src",
	"commit",
	"commits",
	"issues",
	"pull",
	"pulls",
	"raw",
	"archive",
	"releases",
	"wiki",
	"actions",
	"blame",
]);

const stripGitSuffix = (value: string): string => value.replace(GIT_SUFFIX, "");

/** Turn a key into one directory name: no separators, lowercased. */
export const slugFor = (key: string): string =>
	key
		.replace(/^local:/, "local-")
		.replace(/[/\\:]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.toLowerCase();

const remoteIdentity = (host: string, path: string): RepoIdentity | undefined => {
	const cleanHost = host.toLowerCase().replace(/^www\./, "");
	if (path.split("/").filter(Boolean).length < 2) return undefined;
	const key = `${cleanHost}/${path.toLowerCase()}`;
	return {
		key,
		source: `https://${cleanHost}/${path}`,
		display: `${cleanHost}/${path}`,
		kind: "remote",
		slug: slugFor(key),
	};
};

/** The repo path out of a URL path: two segments, stopping at a forge route. */
const repoPathOf = (pathname: string): string => {
	const segments = pathname.split("/").filter(Boolean);
	const routeAt = segments.findIndex((segment) => ROUTE_WORDS.has(segment));
	return stripGitSuffix((routeAt > 0 ? segments.slice(0, routeAt) : segments).slice(0, 2).join("/"));
};

/**
 * Parse a remote repo reference. Accepts:
 *
 *   https://github.com/owner/name(.git)(/tree/...)(?query)(#frag)
 *   git@github.com:owner/name.git
 *   ssh://git@github.com/owner/name.git
 *   git://github.com/owner/name
 *   github.com/owner/name
 *   owner/name                     (GitHub assumed)
 *
 * Hosts other than GitHub are accepted as long as the reference names a host (GitLab, Codeberg, a
 * self-hosted Forgejo), since the identity is host-qualified.
 */
export function parseRemoteRepo(input: string): RepoIdentity {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("repo is empty");

	let host: string | undefined;
	let pathname: string | undefined;

	if (trimmed.includes("://")) {
		let url: URL;
		try {
			url = new URL(trimmed.replace(/^git\+/, ""));
		} catch {
			throw new Error(`repo is not a URL: ${trimmed}`);
		}
		host = url.hostname;
		pathname = url.pathname;
	} else {
		const scp = SCP_STYLE.exec(trimmed);
		if (scp) {
			host = scp[1];
			pathname = scp[2];
		} else if (HOSTISH.test(trimmed.split("/")[0] ?? "")) {
			const slash = trimmed.indexOf("/");
			host = trimmed.slice(0, slash);
			pathname = trimmed.slice(slash + 1);
		} else if (OWNER_NAME.test(trimmed)) {
			host = "github.com";
			pathname = trimmed;
		}
	}

	if (!host || !pathname) {
		throw new Error(
			`repo is not a git repo reference: ${trimmed}. Pass a git URL (https://github.com/owner/name), host/owner/name, owner/name, or a local path.`,
		);
	}

	const identity = remoteIdentity(host, repoPathOf(pathname));
	if (!identity) {
		throw new Error(`repo reference does not name both an owner and a repo: ${trimmed}`);
	}
	return identity;
}

/** A local checkout is identified by its origin when it has one, so a worktree matches its remote. */
export function localRepoIdentity(absPath: string, origin: string | undefined): RepoIdentity {
	if (origin) {
		try {
			// The key comes from the origin so a worktree shares its remote's session, but the code
			// read is the local path: that is the tree the caller is asking about.
			return { ...parseRemoteRepo(origin), source: absPath, kind: "local" };
		} catch {
			// An origin we cannot parse (a bare local path, a bare repo) is not an identity.
		}
	}
	const key = `local:${absPath}`;
	return { key, source: absPath, display: absPath, kind: "local", slug: slugFor(key) };
}

/** A filename-safe cache key for a session file. */
export const sessionFileName = (key: string): string =>
	key.replace(/^local:/, "local-").replace(/[^\w.-]+/g, "_") || "repo";
