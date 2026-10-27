import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import nestedAgents from "./index.ts";
import { ENTRY_TYPE } from "./config.ts";

let root: string;

function write(rel: string, body: string): string {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
	return abs;
}

function makePi() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data });
		},
	};
	const emit = async (event: string, payload: any, ctx: any) => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = await handler(payload, ctx);
			if (r !== undefined) result = r;
		}
		return result;
	};
	return { pi: pi as any, emit, entries, handlers };
}

function makeCtx(transcriptEntries: unknown[] = []) {
	return {
		cwd: root,
		sessionManager: { buildContextEntries: () => transcriptEntries },
	};
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-agents-handler-"));
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	write("AGENTS.md", "ROOT RULES");
	write("packages/AGENTS.md", "PACKAGES RULES");
	write("packages/api/AGENTS.md", "API RULES");
	write("packages/api/handler.ts", "export const h = 1;");
	write("src/thing.ts", "export const t = 1;");
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("extension wiring", () => {
	test("subscribes to exactly the events it needs", () => {
		const { pi, handlers } = makePi();
		nestedAgents(pi);
		assert.deepEqual([...handlers.keys()].sort(), ["session_compact", "session_start", "tool_result"]);
	});

	test("read of a nested file appends instructions to the result", async () => {
		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [{ type: "text", text: "FILE" }] },
			makeCtx(),
		);
		const text = result.content.map((c: any) => c.text).join("");
		assert.ok(text.startsWith("FILE"), "original content preserved");
		assert.ok(text.includes("PACKAGES RULES"));
		assert.ok(text.includes("API RULES"));
		assert.equal(entries.length, 2, "one transcript marker per delivered file");
		assert.equal(entries[0].customType, ENTRY_TYPE);
	});

	test("the returned content array keeps the original entries first", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const original = [{ type: "text", text: "ORIGINAL" }];
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: original },
			makeCtx(),
		);
		assert.equal(result.content[0].text, "ORIGINAL");
		assert.equal(result.content.length, 2);
	});

	test("write triggers injection (a new file was never read)", async () => {
		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "write", input: { path: "packages/api/new.ts" }, content: [{ type: "text", text: "OK" }] },
			makeCtx(),
		);
		assert.ok(result);
		assert.equal(entries.length, 2);
	});

	test("edit DOES inject (the edit tool reads via fs, not the read tool)", async () => {
		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "edit", input: { path: "packages/api/handler.ts" }, content: [{ type: "text", text: "OK" }] },
			makeCtx(),
		);
		assert.ok(result, "edit injects");
		const text = result.content.map((c: any) => c.text).join("");
		assert.ok(text.includes("API RULES"));
		assert.equal(entries.length, 2);
	});

	test("a file_path alias resolves the same as path (pi's renderers accept both)", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { file_path: "packages/api/handler.ts" }, content: [{ type: "text", text: "OK" }] },
			makeCtx(),
		);
		assert.ok(result, "file_path alias resolves");
		const text = result.content.map((c: any) => c.text).join("");
		assert.ok(text.includes("API RULES"));
	});

	test("path wins when both path and file_path are present", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts", file_path: "src/thing.ts" }, content: [] },
			makeCtx(),
		);
		assert.ok(result, "path is authoritative");
		assert.ok(result.content.map((c: any) => c.text).join("").includes("API RULES"));
	});

	test("bash does NOT inject (no path in the input)", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "bash", input: { command: "cat packages/api/handler.ts" }, content: [{ type: "text", text: "OUT" }] },
			makeCtx(),
		);
		assert.equal(result, undefined);
	});

	test("a second read of the same file returns undefined (already delivered)", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const event = { toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] };
		const ctx = makeCtx();
		assert.ok(await emit("tool_result", event, ctx), "first read injects");
		assert.equal(await emit("tool_result", event, ctx), undefined, "second read is a no-op");
	});

	test("a file with no governing context is a no-op", async () => {
		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "src/thing.ts" }, content: [] },
			makeCtx(),
		);
		assert.equal(result, undefined);
		assert.equal(entries.length, 0);
	});

	test("editing a rule file re-injects it on the next read", async () => {
		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const event = { toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] };
		const ctx = makeCtx();
		await emit("tool_result", event, ctx);

		write("packages/api/AGENTS.md", "API RULES CHANGED");
		const result = await emit("tool_result", event, ctx);
		assert.ok(result, "changed file re-injects");
		const text = result.content.map((c: any) => c.text).join("");
		assert.ok(text.includes("API RULES CHANGED"));
		assert.ok(!text.includes("PACKAGES RULES"), "unchanged sibling is not re-sent");
		assert.equal(entries.length, 3, "two initial markers plus one for the change");

		write("packages/api/AGENTS.md", "API RULES");
	});
});

describe("resume via session_start", () => {
	test("markers in the transcript suppress re-injection", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);

		const prior = [
			{ type: "custom", customType: ENTRY_TYPE, data: { path: path.join(root, "packages/AGENTS.md"), hash: "stale-a" } },
			{ type: "custom", customType: ENTRY_TYPE, data: { path: path.join(root, "packages/api/AGENTS.md"), hash: "stale-b" } },
		];
		const ctx = makeCtx(prior);
		await emit("session_start", { type: "session_start", reason: "resume" }, ctx);

		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			ctx,
		);
		assert.ok(result);
	});

	test("markers with CURRENT hashes suppress re-injection entirely", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);

		const { hashContent } = await import("./logic.ts");
		const a = fs.readFileSync(path.join(root, "packages/AGENTS.md"), "utf-8");
		const b = fs.readFileSync(path.join(root, "packages/api/AGENTS.md"), "utf-8");
		const prior = [
			{ type: "custom", customType: ENTRY_TYPE, data: { path: path.join(root, "packages/AGENTS.md"), hash: hashContent(a) } },
			{ type: "custom", customType: ENTRY_TYPE, data: { path: path.join(root, "packages/api/AGENTS.md"), hash: hashContent(b) } },
		];
		const ctx = makeCtx(prior);
		await emit("session_start", { type: "session_start", reason: "resume" }, ctx);

		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			ctx,
		);
		assert.equal(result, undefined, "resume does not re-inject unchanged instructions");
	});

	test("session_start ignores markers from other extensions", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const prior = [{ type: "custom", customType: "someone-else", data: { path: path.join(root, "packages/AGENTS.md"), hash: "x" } }];
		const ctx = makeCtx(prior);
		await emit("session_start", { type: "session_start", reason: "resume" }, ctx);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			ctx,
		);
		assert.ok(result, "foreign markers do not suppress our injection");
	});
});

describe("never inject the same file twice", () => {
	test("same file through two logical paths (symlink) injects once", async () => {
		const aliasDir = path.join(root, "symlinked");
		const realDir = path.join(root, "realpkg");
		fs.mkdirSync(realDir, { recursive: true });
		fs.mkdirSync(aliasDir, { recursive: true });
		fs.writeFileSync(path.join(realDir, "AGENTS.md"), "REAL RULES");
		fs.writeFileSync(path.join(realDir, "a.ts"), "export const a = 1;");
		fs.writeFileSync(path.join(aliasDir, "b.ts"), "export const b = 1;");
		fs.symlinkSync(path.join(realDir, "AGENTS.md"), path.join(aliasDir, "AGENTS.md"));

		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const ctx = makeCtx();

		const first = await emit("tool_result", { toolName: "read", input: { path: "realpkg/a.ts" }, content: [] }, ctx);
		assert.ok(first, "first path injects");
		const second = await emit("tool_result", { toolName: "read", input: { path: "symlinked/b.ts" }, content: [] }, ctx);
		assert.equal(second, undefined, "the aliased path is recognised as the same file");
		assert.equal(entries.length, 1, "one marker, not two");
	});

	test("a resume in a NEW process rebuilds from the transcript, not from empty", async () => {
		const { pi: pi1, emit: emit1, entries } = makePi();
		nestedAgents(pi1);
		await emit1("tool_result", { toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] }, makeCtx());

		const transcript = entries.map((e) => ({
			type: "custom",
			customType: e.customType,
			data: e.data,
		}));
		const { pi: pi2, emit: emit2 } = makePi();
		nestedAgents(pi2);
		const ctx2 = makeCtx(transcript);
		await emit2("session_start", { type: "session_start", reason: "resume" }, ctx2);
		const result = await emit2(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			ctx2,
		);
		assert.equal(result, undefined, "the new process knows the file was already sent");
	});

	test("session_start REPLACES the map, so stale in-memory state cannot suppress a re-inject", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const ctx = makeCtx();
		await emit("tool_result", { toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] }, ctx);

		const emptyCtx = makeCtx([]);
		await emit("session_start", { type: "session_start", reason: "new" }, emptyCtx);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			emptyCtx,
		);
		assert.ok(result, "a cleared transcript re-arms delivery");
	});

	test("an injected block in a tool result counts as delivered, even with no marker", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);

		const blockPath = path.join(root, "packages/api/AGENTS.md");
		const body = fs.readFileSync(blockPath, "utf-8");
		const transcript = [
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [
						{
							type: "text",
							text: 'file body\n\n<project_instructions path="' + blockPath + '">\n' + body + "\n</project_instructions>",
						},
					],
				},
			},
		];
		const ctx = makeCtx(transcript);
		await emit("session_start", { type: "session_start", reason: "resume" }, ctx);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			ctx,
		);
		const text = result.content.map((c: any) => c.text).join("");
		assert.ok(text.includes("PACKAGES RULES"), "the file with no block is still delivered");
		assert.ok(!text.includes("API RULES"), "the file with a surviving block is not re-sent");
	});

	test("session_compact re-arms a file whose marker was dropped", async () => {
		const { pi, emit } = makePi();
		nestedAgents(pi);
		const ctx = makeCtx();
		await emit("tool_result", { toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] }, ctx);

		const compactedCtx = makeCtx([
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "summary" }] } },
		]);
		await emit("session_compact", { type: "session_compact", reason: "threshold" }, compactedCtx);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "packages/api/handler.ts" }, content: [] },
			compactedCtx,
		);
		assert.ok(result, "after a compaction that lost the record, the file is delivered again");
	});
	test("one tool_result never repeats an identity across the chain", async () => {
		const shared = path.join(root, "h-batch/shared.md");
		fs.mkdirSync(path.dirname(shared), { recursive: true });
		fs.writeFileSync(shared, "SHARED BATCH RULES");
		const parent = path.join(root, "h-batch/pkg");
		const child = path.join(root, "h-batch/pkg/sub");
		fs.mkdirSync(child, { recursive: true });
		fs.symlinkSync(shared, path.join(parent, "AGENTS.md"));
		fs.symlinkSync(shared, path.join(child, "AGENTS.md"));
		fs.writeFileSync(path.join(child, "file.ts"), "export const x = 1;");

		const { pi, emit, entries } = makePi();
		nestedAgents(pi);
		const result = await emit(
			"tool_result",
			{ toolName: "read", input: { path: "h-batch/pkg/sub/file.ts" }, content: [] },
			makeCtx(),
		);
		const text = result.content.map((c: any) => c.text).join("");
		const blocks = (text.match(/project_instructions path=/g) ?? []).length;
		assert.equal(blocks, 1, "one block, not two");
		assert.equal(entries.length, 1, "one marker, not two");
	});
});
