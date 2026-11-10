export const TOOL_NAMES = { search: "tinyfish_search", fetch: "tinyfish_fetch_content" } as const;

/** The MCP-era name, still registered so a prompt written before the move keeps calling. */
export const DOTTED = {
	search: `tinyfish.${TOOL_NAMES.search.slice("tinyfish_".length)}`,
	fetch: `tinyfish.${TOOL_NAMES.fetch.slice("tinyfish_".length)}`,
} as const;
