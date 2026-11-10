import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { captureFromCli, EMPTY_STORE, readStore, saveCursor, storePath, type AccountStore } from "./accounts.ts";
import { CALL_CONFIG, POOL_CONFIG } from "./config.ts";
import { createClient, type Client } from "./client.ts";
import { envelope, OUTPUT_SCHEMA } from "./envelope.ts";
import { MCP_NAMES, TOOL_NAMES } from "./names.ts";
import {
	FETCH_DESCRIPTION,
	FETCH_PARAMETERS,
	SEARCH_DESCRIPTION,
	SEARCH_PARAMETERS,
	type FetchParams,
	type SearchParams,
} from "./params.ts";
import { createPool, cursorOf, type Pool } from "./pool.ts";

const NAMESPACE = {
	name: "tinyfish",
	description: "TinyFish web search and page fetch",
	// `tools` resolves an identifier, never a dotted path, so this is the only way a pre-move prompt's
	// `tools.tinyfish.search` still reads. Registering the dotted name twice would not help.
	instructions: `MCP-era names: ${MCP_NAMES.search} is tools.tinyfish_search, ${MCP_NAMES.fetch} is tools.tinyfish_fetch_content.`,
} as const;

type Definition = Omit<ToolDefinition, "name">;

export default function tinyfish(pi: ExtensionAPI): void {
	let store: AccountStore = EMPTY_STORE;
	let built: { client: Client; pool: Pool } | undefined;

	const deps = () => {
		if (built === undefined) {
			const pool = createPool({ store, config: POOL_CONFIG });
			built = { client: createClient({ pool, config: CALL_CONFIG, poolConfig: POOL_CONFIG }), pool };
		}
		return built;
	};

	const search: Definition = {
		label: "TinyFish search",
		description: SEARCH_DESCRIPTION,
		parameters: SEARCH_PARAMETERS,
		outputSchema: OUTPUT_SCHEMA,
		exposure: "codemode",
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			return envelope(await deps().client.search(params as SearchParams, signal));
		},
	};

	const fetchContent: Definition = {
		label: "TinyFish fetch",
		description: FETCH_DESCRIPTION,
		parameters: FETCH_PARAMETERS,
		outputSchema: OUTPUT_SCHEMA,
		exposure: "codemode",
		namespace: NAMESPACE,
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params, signal) {
			return envelope(await deps().client.fetchContent(params as FetchParams, signal));
		},
	};

	pi.registerTool({ ...search, name: TOOL_NAMES.search });
	pi.registerTool({ ...fetchContent, name: TOOL_NAMES.fetch });

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await readStore();
		if (loaded.brokenAt !== null) {
			ctx.ui.notify(
				`TinyFish: ${storePath()} would not parse, so its keys are not in play this session. The bytes are kept at ${loaded.brokenAt}.`,
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
