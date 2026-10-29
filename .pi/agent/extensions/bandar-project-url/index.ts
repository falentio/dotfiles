import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ATTRIBUTION_PROVIDERS } from "./config.ts";
import { PROJECT_URL_HEADER, SESSION_ID_HEADER } from "./headers.ts";
import { projectUrlOfRemotes, remotesOf } from "./project-url.ts";

const GIT_TIMEOUT_MS = 5_000;

export default function bandarProjectUrl(pi: ExtensionAPI): void {
	const urls = new Map<string, Promise<string | null>>();

	function projectUrlFor(cwd: string): Promise<string | null> {
		const cached = urls.get(cwd);
		if (cached !== undefined) return cached;

		const pending = pi
			.exec("git", ["-C", cwd, "config", "--local", "--get-regexp", "^remote\\."], {
				timeout: GIT_TIMEOUT_MS,
			})
			.then((result) =>
				result.code === 0 ? projectUrlOfRemotes(remotesOf(result.stdout)) : null,
			)
			.catch(() => null);
		urls.set(cwd, pending);
		return pending;
	}

	pi.on("before_provider_headers", async (event, ctx) => {
		const provider = ctx.model?.provider;
		if (provider === undefined || !ATTRIBUTION_PROVIDERS.includes(provider)) return;
		event.headers[SESSION_ID_HEADER] = ctx.sessionManager.getSessionId();
		const url = await projectUrlFor(ctx.cwd);
		if (url !== null) event.headers[PROJECT_URL_HEADER] = url;
	});
}
