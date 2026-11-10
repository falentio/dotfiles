import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { captureFromCli, EMPTY_STORE, readStore, saveCursor, storePath, type AccountStore } from "./accounts.ts";
import { CALL_CONFIG, POOL_CONFIG } from "./config.ts";
import { createClient, type Client } from "./client.ts";
import { FETCH_DESCRIPTION, FETCH_PARAMETERS, SEARCH_DESCRIPTION, SEARCH_PARAMETERS, type FetchParams, type SearchParams } from "./params.ts";
import { createPool, cursorOf, type Pool } from "./pool.ts";

const NAMESPACE = { name: "tinyfish", description: "TinyFish web search and page fetch" } as const;

/** The MCP envelope, byte for byte: the API body JSON-serialized, no response schema in between. */
const envelope = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	details: undefined,
});

export default function tinyfish(pi: ExtensionAPI): void {
	let store: AccountStore = EMPTY_STORE;
	let built: { client: Client; pool: Pool } | undefined;

	/** Built lazily, so the pool seeds from a store the session_start read has already filled. */
	const deps = () => {
		if (built === undefined) {
			const pool = createPool({ store, config: POOL_CONFIG });
			built = { client: createClient({ pool, config: CALL_CONFIG }), pool };
		}
		return built;
	};

	pi.registerTool({
		name: "tinyfish_search",
		label: "TinyFish search",
		description: SEARCH_DESCRIPTION,
		parameters: SEARCH_PARAMETERS,
		exposure: "codemode",
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_id: string, params: SearchParams, signal: AbortSignal) {
			return envelope(await deps().client.search(params, signal));
		},
	});

	pi.registerTool({
		name: "tinyfish_fetch_content",
		label: "TinyFish fetch",
		description: FETCH_DESCRIPTION,
		parameters: FETCH_PARAMETERS,
		exposure: "codemode",
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id: string, params: FetchParams, signal: AbortSignal) {
			return envelope(await deps().client.fetchContent(params, signal));
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await readStore();
		if (loaded.brokenAt !== null) {
			const why = ctx.hasUI ? "" : " The keys still in there are not in play this session.";
			ctx.ui.notify(
				`TinyFish: ${storePath()} would not parse, so its keys are not loaded. The bytes are kept at ${loaded.brokenAt}.${why}`,
				"error",
			);
		}
		store = await captureFromCli(loaded.store);
		built = undefined;
	});

	pi.on("session_shutdown", async () => {
		const cursor = cursorOf(built?.pool.snapshot());
		built = undefined;
		await saveCursor(store, cursor);
		store = EMPTY_STORE;
	});
}
