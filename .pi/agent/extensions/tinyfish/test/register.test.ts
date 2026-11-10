import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import tinyfish from "../index.ts";
import { MCP_NAMES, TOOL_NAMES } from "../names.ts";
import { json, startStub, type Stub } from "./stub.ts";

let stub: Stub;
let dir: string;

beforeAll(() => {
	stub = startStub();
	dir = mkdtempSync(join(tmpdir(), "tinyfish-register-"));
	const store = join(dir, "accounts.json");
	writeFileSync(store, JSON.stringify({ accounts: [{ id: "a1", label: "a1", key: "key-a1", weight: 1 }], cursor: null }));
	process.env.TINYFISH_SEARCH_BASE_URL = stub.searchBase;
	process.env.TINYFISH_FETCH_BASE_URL = stub.fetchBase;
	process.env.TINYFISH_ACCOUNTS_FILE = store;
});

afterAll(() => {
	stub.stop();
	rmSync(dir, { recursive: true, force: true });
});

/** The two calls the extension makes on `pi`, keeping the definitions so a test can run one. */
const registered = () => {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		on() {},
	} as unknown as ExtensionAPI;
	tinyfish(pi);
	return tools;
};

const call = async (name: string, params: Record<string, unknown>) => {
	const tool = registered().get(name);
	if (tool === undefined) throw new Error(`${name} is not registered`);
	return (await tool.execute("id", params, undefined, undefined, undefined as never)) as {
		content: { type: string; text: string }[];
		structuredContent?: unknown;
	};
};

const searchBody = (body: unknown) => stub.script("key-a1", "search", [{ status: 200, body }]);

describe("the registered tools", () => {
	it("registers each definition exactly once, under the flat name", () => {
		expect([...registered().keys()].sort()).toEqual(Object.values(TOOL_NAMES).sort());
	});

	it("keeps the MCP-era name resolved to a real member, so a stale prompt has a mapping", () => {
		for (const [kind, flat] of Object.entries(TOOL_NAMES)) {
			expect(MCP_NAMES[kind as keyof typeof MCP_NAMES].replace(".", "_")).toBe(flat);
		}
	});

	it("takes a fetch with only urls and format, which is the call the MCP accepted", async () => {
		await call(TOOL_NAMES.fetch, { urls: ["https://x.test"], format: "markdown" });
		expect(stub.hit("key-a1", "fetch")).toBe(1);
	});

	it("takes a research call that names only the query, with top defaulting to three", async () => {
		stub.script("key-a1", "search", [json(200, { query: "q", results: [{ title: "A", url: "https://a.test/1" }] })]);
		stub.script("key-a1", "fetch", [json(200, { results: [], errors: [] })]);
		const result = await call(TOOL_NAMES.research, { query: "q" });
		expect((result.structuredContent as { sources: string[] }).sources).toEqual(["https://a.test/1"]);
	});

	it("declares an output schema, which is what makes a script receive structured content", () => {
		for (const tool of registered().values()) expect(tool.outputSchema).toBeDefined();
	});
});

describe("a call result", () => {
	it("resolves to the body object, so a script can read .results off it", async () => {
		const body = { query: "q", results: [{ title: "t" }], total_results: 1 };
		searchBody(body);
		const result = await call(TOOL_NAMES.search, { query: "q" });
		expect(result.structuredContent).toEqual(body);
	});

	it("wraps a bare array or primitive in { value }, because a script reads a property", async () => {
		searchBody([{ title: "t" }]);
		expect((await call(TOOL_NAMES.search, { query: "q" })).structuredContent).toEqual({ value: [{ title: "t" }] });
		searchBody("plain");
		expect((await call(TOOL_NAMES.search, { query: "q" })).structuredContent).toEqual({ value: "plain" });
	});

	it("summarizes in content instead of repeating the body, which is the structured side's job", async () => {
		searchBody({ query: "q", total_results: 0, results: [], errors: [] });
		expect((await call(TOOL_NAMES.search, { query: "q" })).content).toEqual([
			{ type: "text", text: '0 results for "q"' },
		]);
	});
});
