export const TOOL_NAMES = { search: "tinyfish_search", fetch: "tinyfish_fetch_content" } as const;

/**
 * The MCP-era name. A tool name becomes one flat script identifier (a "." normalizes to "_"), so this
 * is reachable as `tools["tinyfish.search"]` and never as `tools.tinyfish.search`. Nothing registers it:
 * registering it twice would only double `searchTools` and `describeNamespace`.
 */
export const MCP_NAMES = {
	search: `tinyfish.${TOOL_NAMES.search.slice("tinyfish_".length)}`,
	fetch: `tinyfish.${TOOL_NAMES.fetch.slice("tinyfish_".length)}`,
} as const;
