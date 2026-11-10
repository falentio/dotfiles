export const TOOL_NAMES = { search: "tinyfish_search", fetch: "tinyfish_fetch_content", research: "tinyfish_research" } as const;

/**
 * The MCP-era name. A tool name becomes one flat script identifier and "." normalizes to "_", so this
 * resolves to the same member as `TOOL_NAMES` and is never a `tools.tinyfish` object. It is exposed to
 * scripts as a lookup table, because nothing else can reach it.
 */
export const MCP_NAMES = { search: "tinyfish.search", fetch: "tinyfish.fetch_content", research: "tinyfish.research" } as const;
