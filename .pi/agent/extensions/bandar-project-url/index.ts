import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	PROJECT_URL_HEADER,
	projectUrlOfRemotes,
	type Remote,
} from "./project-url.ts";

const GIT_TIMEOUT_MS = 5_000;

function remotesOf(stdout: string): Remote[] {
	const remotes: Remote[] = [];
	for (const line of stdout.split("\n")) {
		const [name, url, kind] = line.trim().split(/\s+/);
		if (name === undefined || url === undefined || kind !== "(fetch)") continue;
		remotes.push({ name, url });
	}
	return remotes;
}

export default function bandarProjectUrl(pi: ExtensionAPI): void {
	const urls = new Map<string, Promise<string | null>>();

	function projectUrlFor(cwd: string): Promise<string | null> {
		const cached = urls.get(cwd);
		if (cached !== undefined) return cached;

		const pending = pi
			.exec("git", ["-C", cwd, "remote", "-v"], { timeout: GIT_TIMEOUT_MS })
			.then((result) =>
				result.code === 0 ? projectUrlOfRemotes(remotesOf(result.stdout)) : null,
			)
			.catch(() => null);
		urls.set(cwd, pending);
		return pending;
	}

	pi.on("before_provider_headers", async (event, ctx) => {
		const url = await projectUrlFor(ctx.cwd);
		if (url !== null) event.headers[PROJECT_URL_HEADER] = url;
	});
}
