export const PROJECT_URL_HEADER = "x-bandar-project-url";

export interface Remote {
	name: string;
	url: string;
}

interface RemoteAddress {
	protocol: string;
	host: string;
	port: string;
	path: string;
}

const SCP_REMOTE = /^(?:[^@/]+@)?([^:/]+):(.+)$/;
const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);

function addressOf(remote: string): RemoteAddress | null {
	const raw = remote.trim();
	if (raw === "") return null;

	const scp = raw.includes("://") ? null : SCP_REMOTE.exec(raw);
	if (scp !== null) {
		const [, host = "", path = ""] = scp;
		if (host === "" || path === "") return null;
		return {
			protocol: "ssh:",
			host: host.toLowerCase(),
			port: "",
			path: path.startsWith("/") ? path : `/${path}`,
		};
	}

	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}

	if (!REMOTE_PROTOCOLS.has(url.protocol) || url.hostname === "") return null;
	return { protocol: url.protocol, host: url.hostname, port: url.port, path: url.pathname };
}

export function projectUrlOfRemote(remote: string): string | null {
	const address = addressOf(remote);
	if (address === null) return null;

	const path = address.path.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
	if (path === "") return null;

	// bandar drops a header it cannot parse as an absolute http(s) url, so an ssh or git remote keeps its host and moves to https.
	const protocol = address.protocol === "http:" ? "http:" : "https:";
	const port =
		address.protocol === "http:" || address.protocol === "https:" ? address.port : "";
	return `${protocol}//${address.host}${port === "" ? "" : `:${port}`}${path}`;
}

export function remotesOf(config: string): Remote[] {
	const remotes: Remote[] = [];
	for (const rawLine of config.split("\n")) {
		const match = /^remote\.(.+?)\.url (.*)$/.exec(rawLine.replace(/\r$/, ""));
		if (match === null) continue;
		const [, name, url] = match;
		if (name === undefined || url === undefined) continue;
		remotes.push({ name, url });
	}
	return remotes;
}

export function projectUrlOfRemotes(remotes: ReadonlyArray<Remote>): string | null {
	const ordered = [
		...remotes.filter((remote) => remote.name === "origin"),
		...remotes.filter((remote) => remote.name !== "origin"),
	];

	for (const remote of ordered) {
		const url = projectUrlOfRemote(remote.url);
		if (url !== null) return url;
	}
	return null;
}
