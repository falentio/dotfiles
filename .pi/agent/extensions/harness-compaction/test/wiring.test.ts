import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import harnessCompaction from "../index.ts";
import { CONFIG, validateConfig } from "../config.ts";
import { codePointLength } from "../prune.ts";

const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKER = CONFIG.marker;

type Handler = (event: unknown, ctx: unknown) => unknown;
type Usage = { tokens: number | null; contextWindow: number };

function fakePi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, commands };
}

function context(usage?: Usage) {
	const notices: string[] = [];
	const ctx = {
		getContextUsage: () => usage,
		ui: { notify: (message: string) => notices.push(message) },
	};
	return { ctx: ctx as unknown as ExtensionContext, notices };
}

function emit(handlers: Map<string, Handler>, name: string, event: unknown, ctx: ExtensionContext): unknown {
	const handler = handlers.get(name);
	assert.ok(handler, `${name} handler registered`);
	return handler(event, ctx);
}

interface FakeMessage {
	role: string;
	content: Array<{ type: string; text: string }>;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp: number;
}

const textBlock = (text: string) => ({ type: "text", text });
const toolResult = (text: string, toolCallId = "call-1") => ({
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [textBlock(text)],
	isError: false,
	timestamp: 1,
});
const user = (text: string) => ({ role: "user", content: [textBlock(text)], timestamp: 1 });
const assistant = (text: string) => ({ role: "assistant", content: [textBlock(text)], timestamp: 1 });
const compactionEvent = (over: Record<string, unknown> = {}) => ({
	type: "session_before_compact",
	preparation: { firstKeptEntryId: "entry-7", tokensBefore: 1234 },
	branchEntries: [],
	reason: "threshold",
	willRetry: false,
	signal: { aborted: false },
	...over,
});
const big = (length = 9000) => "x".repeat(length);

describe("context hook", () => {
	test("does nothing below the gate", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const messages = [toolResult(big())];
		const before = structuredClone(messages);
		const { ctx } = context({ tokens: 7999, contextWindow: 10_000 });
		assert.equal(emit(handlers, "context", { type: "context", messages }, ctx), undefined);
		assert.deepEqual(messages, before);
	});

	test("does nothing when the token count is unknown", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const messages = [toolResult(big())];
		const before = structuredClone(messages);
		const { ctx } = context({ tokens: null, contextWindow: 10_000 });
		assert.equal(emit(handlers, "context", { type: "context", messages }, ctx), undefined);
		assert.deepEqual(messages, before);
	});

	test("does nothing without context usage", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const messages = [toolResult(big())];
		const before = structuredClone(messages);
		const { ctx } = context(undefined);
		assert.equal(emit(handlers, "context", { type: "context", messages }, ctx), undefined);
		assert.deepEqual(messages, before);
	});

	test("prunes every over-budget tool result at the gate", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const resultContent = [textBlock(big())];
		const smallContent = [textBlock("small")];
		const messages: FakeMessage[] = [
			user(big(10_000)),
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: resultContent, isError: false, timestamp: 1 },
			{ role: "toolResult", toolCallId: "call-2", toolName: "read", content: smallContent, isError: true, timestamp: 2 },
			assistant("done"),
		];
		const { ctx } = context({ tokens: 8000, contextWindow: 10_000 });
		assert.deepEqual(emit(handlers, "context", { type: "context", messages }, ctx), {});

		const pruned = messages[1]?.content as Array<{ type: "text"; text: string }>;
		assert.notEqual(messages[1]?.content, resultContent);
		assert.equal(codePointLength(pruned[0]?.text ?? ""), CONFIG.headChars + codePointLength(MARKER) + CONFIG.tailChars);
		assert.equal(pruned[0]?.text.split(MARKER).length, 2);
		assert.equal(messages[1]?.toolCallId, "call-1");
		assert.equal(messages[2]?.content, smallContent);
		assert.deepEqual(messages[0]?.content, [textBlock(big(10_000))]);
	});

	test("prunes only the tool results above the threshold", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const atThreshold = [textBlock(big(CONFIG.thresholdChars))];
		const overThreshold = [textBlock(big(CONFIG.thresholdChars + 1))];
		const messages = [
			{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: atThreshold, isError: false, timestamp: 1 },
			{ role: "toolResult", toolCallId: "call-2", toolName: "read", content: overThreshold, isError: false, timestamp: 2 },
		];
		const { ctx } = context({ tokens: 9000, contextWindow: 10_000 });
		emit(handlers, "context", { type: "context", messages }, ctx);

		assert.equal(messages[0]?.content, atThreshold);
		assert.notEqual(messages[1]?.content, overThreshold);
	});

	test("a second pass leaves a pruned projection alone", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const messages = [toolResult(big())];
		const { ctx } = context({ tokens: 8000, contextWindow: 10_000 });
		emit(handlers, "context", { type: "context", messages }, ctx);
		const once = structuredClone(messages);
		assert.equal(emit(handlers, "context", { type: "context", messages }, ctx), undefined);
		assert.deepEqual(messages, once);
	});

	test("pruneAtRatio moves the gate", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi, { ...CONFIG, pruneAtRatio: 0.5 });
		const below = [toolResult(big())];
		const { ctx: belowCtx } = context({ tokens: 4999, contextWindow: 10_000 });
		assert.equal(emit(handlers, "context", { type: "context", messages: below }, belowCtx), undefined);
		assert.equal(codePointLength((below[0]?.content as Array<{ text: string }>)[0]?.text ?? ""), 9000);

		const atGate = [toolResult(big())];
		const { ctx: atGateCtx } = context({ tokens: 5000, contextWindow: 10_000 });
		emit(handlers, "context", { type: "context", messages: atGate }, atGateCtx);
		assert.ok(codePointLength((atGate[0]?.content as Array<{ text: string }>)[0]?.text ?? "") < 9000);
	});
});

describe("session_before_compact hook", () => {
	test("keeps pi's cut and supplies no usage", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const { ctx } = context(undefined);
		const result = emit(handlers, "session_before_compact", compactionEvent(), ctx) as {
			compaction: Record<string, unknown>;
		};
		assert.deepEqual(result, {
			compaction: {
				summary: CONFIG.droppedHistoryNote,
				firstKeptEntryId: "entry-7",
				tokensBefore: 1234,
			},
		});
		assert.equal("usage" in result.compaction, false);
	});

	test("falls back to pi's summarizer when custom instructions are present", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		const { ctx } = context(undefined);
		assert.equal(
			emit(handlers, "session_before_compact", compactionEvent({ customInstructions: "focus on the API" }), ctx),
			undefined,
		);
	});

	test("both hooks are no-ops when disabled", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi, { ...CONFIG, enabled: false });
		const messages = [toolResult(big())];
		const before = structuredClone(messages);
		const { ctx } = context({ tokens: 99_000, contextWindow: 10_000 });
		assert.equal(emit(handlers, "context", { type: "context", messages }, ctx), undefined);
		assert.deepEqual(messages, before);
		assert.equal(emit(handlers, "session_before_compact", compactionEvent(), ctx), undefined);
	});
});

describe("registration", () => {
	test("hooks the projection and the compaction, never tool_result", () => {
		const { pi, handlers } = fakePi();
		harnessCompaction(pi);
		assert.deepEqual([...handlers.keys()].sort(), ["context", "session_before_compact"]);
	});

	test("the status command reports the gate, usage, and settings", async () => {
		const { pi, commands } = fakePi();
		harnessCompaction(pi);
		const command = commands.get("harness-compaction");
		assert.ok(command);
		const { ctx, notices } = context({ tokens: 9000, contextWindow: 10_000 });
		await command.handler("", ctx);
		const report = notices.join("\n");
		assert.match(report, /^harness-compaction on:/);
		assert.match(report, /9000 of 10000 tokens, gate 8000/);
		assert.match(report, /over 8192 code points to 4096 head, 1024 tail/);
	});

	test("the factory throws on a config that cannot converge", () => {
		const { pi } = fakePi();
		assert.throws(() => harnessCompaction(pi, { ...CONFIG, thresholdChars: 5000 }), RangeError);
	});

	test("validateConfig rejects each malformed field", () => {
		assert.doesNotThrow(() => validateConfig(CONFIG));
		assert.throws(() => validateConfig({ ...CONFIG, thresholdChars: 5000 }), /must be below thresholdChars/);
		assert.throws(() => validateConfig({ ...CONFIG, pruneAtRatio: 1.5 }), RangeError);
		assert.throws(() => validateConfig({ ...CONFIG, headChars: -1 }), RangeError);
		assert.throws(() => validateConfig({ ...CONFIG, enabled: "yes" as unknown as boolean }), TypeError);
		assert.throws(() => validateConfig({ ...CONFIG, marker: "" }), TypeError);
		assert.throws(() => validateConfig({ ...CONFIG, droppedHistoryNote: "" }), TypeError);
	});

	test("the extension never imports pi-ai or calls a model", () => {
		for (const file of ["index.ts", "config.ts", "prune.ts"]) {
			const source = fs.readFileSync(path.join(EXTENSION_DIR, file), "utf-8");
			assert.doesNotMatch(source, /@earendil-works\/pi-ai/, `${file} imports pi-ai`);
			assert.doesNotMatch(source, /generateSummary|\.compact\(|complete\(/, `${file} calls a model`);
		}
	});
});
