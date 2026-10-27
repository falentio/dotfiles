import { afterEach, describe, expect, it } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { PRECOMPUTE_CONFIG, type PrecomputeConfig } from "../config.ts";
import { createBackgroundCompaction, type Summarize } from "../index.ts";
import type { Usage } from "../state.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;
const usage: Usage = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface Harness {
	api: ExtensionAPI;
	handlers: Map<string, Handler[]>;
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<unknown>>;
	statuses: Array<{ key: string; text: string | undefined }>;
	notices: string[];
	branch: SessionEntry[];
	tokens: number | null;
	idle: boolean;
	pending: boolean;
	compactCalls: unknown[];
	ctx: ExtensionContext;
}

let nextId = 0;

function user(text: string): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `u${nextId}`,
		parentId: null,
		timestamp: new Date(1_700_000_000_000 + nextId).toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: nextId },
	};
}

function assistant(text: string): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `a${nextId}`,
		parentId: null,
		timestamp: new Date(1_700_000_000_000 + nextId).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "mock-api",
			provider: "mock",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: nextId,
		},
	};
}

function giantBranch(): SessionEntry[] {
	return [user("u".repeat(100_000)), assistant("a".repeat(100_000))];
}

function makeBranch(): SessionEntry[] {
	nextId = 0;
	return giantBranch();
}

const model = {
	id: "fixture",
	name: "Fixture",
	api: "mock-api",
	provider: "mock",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

interface SummaryCall {
	args: Parameters<Summarize>;
	resolve: (value: { text: string; usage: Usage }) => void;
	reject: (error: Error) => void;
}

function makeHarness(
	overrides: Partial<PrecomputeConfig> = {},
	summaryCalls: SummaryCall[] = [],
): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<unknown>>();
	const statuses: Harness["statuses"] = [];
	const notices: string[] = [];
	const compactCalls: unknown[] = [];
	const harness: Partial<Harness> = {
		handlers,
		commands,
		statuses,
		notices,
		compactCalls,
		branch: makeBranch(),
		tokens: 160_000,
		idle: true,
		pending: false,
	};

	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<unknown> }) => {
			commands.set(name, options.handler);
		},
	} as unknown as ExtensionAPI;

	const summarize: Summarize = (messages, summaryModel, reserve, apiKey, headers, signal, custom, previous, thinking) =>
		new Promise((resolve, reject) => {
			summaryCalls.push({
				args: [messages, summaryModel, reserve, apiKey, headers, signal, custom, previous, thinking],
				resolve,
				reject,
			});
		});

	const ctx = {
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
			notify: (message: string) => {
				notices.push(message);
			},
		},
		sessionManager: { getBranch: () => harness.branch },
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-test": "1" } }),
		},
		isIdle: () => harness.idle,
		hasPendingMessages: () => harness.pending,
		getContextUsage: () => ({
			tokens: harness.tokens,
			contextWindow: 200_000,
			percent: null,
		}),
		compact: (options: unknown) => {
			compactCalls.push(options);
		},
		thinkingLevel: "off",
	} as unknown as ExtensionContext;

	harness.api = api;
	harness.ctx = ctx;

	createBackgroundCompaction({ ...PRECOMPUTE_CONFIG, ...overrides }, { summarize })(api);
	return harness as Harness;
}

async function emit(h: Harness, name: string, event: unknown): Promise<unknown> {
	let result: unknown;
	for (const handler of h.handlers.get(name) ?? []) {
		const value = await handler(event as never, h.ctx);
		if (value !== undefined) result = value;
	}
	return result;
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 1));
}

async function settle(h: Harness): Promise<void> {
	await emit(h, "agent_settled", { type: "agent_settled" });
	await flush();
}

function lastStatus(h: Harness): string | undefined {
	return h.statuses.at(-1)?.text;
}

function statusTexts(h: Harness): Array<string | undefined> {
	return h.statuses.map((entry) => entry.text);
}

function beforeCompact(
	h: Harness,
	overrides: Partial<SessionBeforeCompactEvent> = {},
): SessionBeforeCompactEvent {
	const plan = {
		firstKeptEntryId: h.branch[1]?.id ?? "missing",
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 123_456,
		previousSummary: undefined,
		fileOps: { readFiles: [], modifiedFiles: [] },
		settings: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
	};
	return {
		type: "session_before_compact",
		preparation: plan,
		branchEntries: h.branch,
		customInstructions: undefined,
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
		...overrides,
	} as SessionBeforeCompactEvent;
}

function compactionEvent(h: Harness): SessionCompactEvent {
	return {
		type: "session_compact",
		compactionEntry: {
			type: "compaction",
			id: "compaction-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			summary: "compacted",
			firstKeptEntryId: h.branch[1]?.id ?? "missing",
			tokensBefore: 100_000,
		},
		fromExtension: true,
		reason: "manual",
		willRetry: false,
	};
}

describe("event wiring", () => {
	it("registers every frozen event and the command", () => {
		const h = makeHarness();
		for (const event of [
			"session_start",
			"agent_settled",
			"session_before_compact",
			"session_compact",
			"model_select",
			"session_shutdown",
		]) {
			expect(h.handlers.has(event)).toBe(true);
		}
		expect(h.commands.has("precompute")).toBe(true);
	});

	it("does nothing at all when disabled", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({ enabled: false }, calls);
		await settle(h);
		expect(calls.length).toBe(0);
		expect(h.compactCalls.length).toBe(0);
		expect(h.statuses.length).toBe(0);
		await emit(h, "session_start", { type: "session_start", reason: "startup" });
		expect(h.statuses.length).toBe(0);
	});

	it("starts one summary at the gate and reports summarizing", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		expect(calls.length).toBe(1);
		expect(lastStatus(h)).toBe("precompute: summarizing...");
		expect(calls[0]?.args[2]).toBe(PRECOMPUTE_CONFIG.reserveTokens);
		expect(calls[0]?.args[3]).toBe("test-key");
		expect(calls[0]?.args[7]).toBeUndefined();
	});

	it("keeps at most one summary in flight", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		await settle(h);
		expect(calls.length).toBe(1);
	});

	it("compacts a ready summary while idle", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		expect(lastStatus(h)).toBe("precompute: summary ready");
		expect(h.compactCalls.length).toBe(1);
	});

	it("stays ready while the agent is busy", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		h.idle = false;
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		expect(lastStatus(h)).toBe("precompute: summary ready");
		expect(h.compactCalls.length).toBe(0);
		h.idle = true;
		await settle(h);
		expect(h.compactCalls.length).toBe(1);
	});

	it("rechecks idle inside the deferred compact callback", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		for (let i = 0; i < 8; i++) await Promise.resolve();
		h.idle = false;
		await new Promise((resolve) => setTimeout(resolve, 1));
		expect(h.compactCalls.length).toBe(0);
		h.idle = true;
		await settle(h);
		expect(h.compactCalls.length).toBe(1);
	});

	it("leaves a rejected summary failed and does not retry the same cut", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.reject(new Error("provider down"));
		await flush();
		expect(lastStatus(h)).toBe("precompute: summary failed");
		await settle(h);
		expect(calls.length).toBe(1);
	});

	it("treats an empty summary as a failure", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "   ", usage });
		await flush();
		expect(lastStatus(h)).toBe("precompute: summary failed");
	});

	it("treats a missing api key as a hard failure", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		(h.ctx.modelRegistry as unknown as { getApiKeyAndHeaders: () => Promise<unknown> }).getApiKeyAndHeaders = async () => ({
			ok: false,
			error: "no auth",
		});
		await settle(h);
		expect(calls.length).toBe(0);
		expect(lastStatus(h)).toBe("precompute: summary failed");
		await settle(h);
		expect(calls.length).toBe(0);
	});

	it("ignores a rejection after the summary was aborted", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		await emit(h, "model_select", {
			type: "model_select",
			model,
			previousModel: undefined,
			source: "set",
		});
		calls[0]!.reject(new Error("aborted"));
		await flush();
		expect(lastStatus(h)).toBeUndefined();
	});

	it("aborts an in-flight controller exactly once on model change", async () => {
		const original = AbortController.prototype.abort;
		let aborts = 0;
		AbortController.prototype.abort = function abortPatched() {
			aborts += 1;
			return original.call(this);
		};
		try {
			const calls: SummaryCall[] = [];
			const h = makeHarness({}, calls);
			await settle(h);
			await emit(h, "model_select", { type: "model_select", model, previousModel: undefined, source: "set" });
			await emit(h, "session_shutdown", { type: "session_shutdown", reason: "quit" });
			expect(aborts).toBe(1);
			expect(lastStatus(h)).toBeUndefined();
		} finally {
			AbortController.prototype.abort = original;
		}
	});

	it("writes summaries but never compacts when compactWhenReady is false", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({ compactWhenReady: false }, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		expect(lastStatus(h)).toBe("precompute: summary ready");
		expect(h.compactCalls.length).toBe(0);
		await settle(h);
		expect(h.compactCalls.length).toBe(0);
	});

	it("hands a ready summary to the hook and marks compacting", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		const result = (await emit(h, "session_before_compact", beforeCompact(h))) as {
			compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: Usage };
		};
		expect(result.compaction).toEqual({
			summary: "the summary",
			firstKeptEntryId: h.branch[1]!.id,
			tokensBefore: 123_456,
			usage,
		});
		expect(lastStatus(h)).toBe("precompute: compacting...");
	});

	it("uses a ready summary for a manual compaction with no instructions", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "manual summary", usage });
		await flush();
		const result = (await emit(
			h,
			"session_before_compact",
			beforeCompact(h, { reason: "manual" }),
		)) as { compaction?: { summary: string } };
		expect(result.compaction?.summary).toBe("manual summary");
	});

	it("leaves the state ready for a compaction the extension did not issue", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({ compactWhenReady: false }, calls);
		await settle(h);
		calls[0]!.resolve({ text: "foreign summary", usage });
		await flush();
		const result = (await emit(
			h,
			"session_before_compact",
			beforeCompact(h, { reason: "manual" }),
		)) as { compaction?: { summary: string } };
		expect(result.compaction?.summary).toBe("foreign summary");
		expect(lastStatus(h)).toBe("precompute: summary ready");
		expect(h.compactCalls.length).toBe(0);
	});

	it("skips the hook when instructions are present", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		const result = await emit(
			h,
			"session_before_compact",
			beforeCompact(h, { customInstructions: "focus" }),
		);
		expect(result).toBeUndefined();
		expect(lastStatus(h)).toBe("precompute: summary ready");
	});

	it("tightens the tail limit on overflow recovery", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({ keepRecentTokens: 1_000 }, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		const overflow = await emit(
			h,
			"session_before_compact",
			beforeCompact(h, { willRetry: true }),
		);
		expect(overflow).toBeUndefined();
		const normal = await emit(h, "session_before_compact", beforeCompact(h));
		expect(normal).toBeDefined();
	});

	it("records a compact error as a failure", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.resolve({ text: "the summary", usage });
		await flush();
		expect(h.compactCalls.length).toBe(1);
		const options = h.compactCalls[0] as unknown as { onError: () => void };
		options.onError();
		expect(lastStatus(h)).toBe("precompute: summary failed");
	});

	it("resets failures and the failed keep id on session_compact", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		calls[0]!.reject(new Error("boom"));
		await flush();
		expect(lastStatus(h)).toBe("precompute: summary failed");
		await emit(h, "session_compact", compactionEvent(h));
		expect(lastStatus(h)).toBeUndefined();
		await settle(h);
		expect(calls.length).toBe(2);
	});

	it("resets on session_start", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		expect(lastStatus(h)).toBe("precompute: summarizing...");
		await emit(h, "session_start", { type: "session_start", reason: "reload" });
		expect(lastStatus(h)).toBeUndefined();
		calls[0]!.reject(new Error("aborted"));
		await flush();
		expect(lastStatus(h)).toBeUndefined();
	});
});

describe("/precompute", () => {
	it("reports one paragraph and writes no status", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		await settle(h);
		const statusesBefore = h.statuses.length;
		await h.commands.get("precompute")!("", h.ctx);
		const report = h.notices.at(-1) ?? "";
		expect(report).toContain("tokens 160000");
		expect(report).toContain("gate 156073");
		expect(report).toContain("ceiling");
		expect(report).toContain("failures 0");
		expect(h.statuses.length).toBe(statusesBefore);
	});

	it("force starts a summary below the gate", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		h.tokens = 1;
		await settle(h);
		expect(calls.length).toBe(0);
		await h.commands.get("precompute")!("force", h.ctx);
		await flush();
		expect(calls.length).toBe(1);
	});

	it("force does nothing while busy", async () => {
		const calls: SummaryCall[] = [];
		const h = makeHarness({}, calls);
		h.tokens = 1;
		h.idle = false;
		await h.commands.get("precompute")!("force", h.ctx);
		await flush();
		expect(calls.length).toBe(0);
	});
});

afterEach(() => {
	nextId = 0;
});
