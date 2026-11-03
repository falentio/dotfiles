import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { IDLE_COMPACT_CONFIG, limits } from "../config.ts";
import { createIdleCompact } from "../index.ts";

type Handler = (event: never, ctx: ExtensionContext) => unknown;

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();

interface Harness {
	run(event: string, payload: Record<string, unknown>, ctx?: ExtensionContext): unknown;
	sent: Array<{ content: unknown; options: { expandPromptTemplates?: boolean } | undefined }>;
	compactions: Array<{ onComplete?: () => void; onError?: (error: Error) => void }>;
	notices: string[];
	ctx: ExtensionContext;
	branch: SessionEntry[];
	compactThrows: boolean;
}

function harness(): Harness {
	const handlers = new Map<string, Handler[]>();
	const sent: Harness["sent"] = [];
	const compactions: Harness["compactions"] = [];
	const notices: string[] = [];
	const state: Harness = {
		run: (event, payload, ctx) => {
			const list = handlers.get(event) ?? [];
			let result: unknown;
			for (const handler of list) result = (handler as unknown as (event: unknown, ctx: ExtensionContext) => unknown)(payload, ctx ?? state.ctx);
			return result;
		},
		sent,
		compactions,
		notices,
		ctx: undefined as unknown as ExtensionContext,
		branch: [],
		compactThrows: false,
	};

	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		sendUserMessage: (content: unknown, options: { expandPromptTemplates?: boolean }) => {
			sent.push({ content, options });
		},
	} as unknown as ExtensionAPI;

	state.ctx = {
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
		getContextUsage: () => ({ tokens: 100_000, contextWindow: 200_000, percent: 50 }),
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => state.branch },
		compact: (options: { onComplete?: () => void; onError?: (error: Error) => void }) => {
			if (state.compactThrows) throw new Error("This extension ctx is stale");
			compactions.push(options);
		},
	} as unknown as ExtensionContext;

	createIdleCompact(IDLE_COMPACT_CONFIG)(api);
	return state;
}

function user(text: string, at: number): SessionEntry {
	return {
		type: "message",
		id: `u${at}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: at },
	};
}

function assistant(at: number): SessionEntry {
	return {
		type: "message",
		id: `a${at}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
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
			timestamp: at,
		},
	};
}

function coldSession(h: Harness): void {
	h.branch = [user("ask", NOW - 3 * HOUR), assistant(NOW - 2 * HOUR)];
	h.run("session_start", { type: "session_start" });
}

const input = (overrides: Record<string, unknown> = {}) => ({
	type: "input",
	text: "keep going",
	source: "interactive",
	...overrides,
});

describe("input wiring", () => {
	it("swallows a cold prompt and starts one compaction", () => {
		const h = harness();
		coldSession(h);
		expect(h.run("input", input())).toEqual({ action: "handled" });
		expect(h.compactions.length).toBe(1);
		expect(h.notices.length).toBe(1);
		expect(h.sent).toEqual([]);
	});

	it("re-sends the swallowed prompt when the compaction completes", () => {
		const h = harness();
		coldSession(h);
		h.run("input", input());
		h.compactions[0]?.onComplete?.();
		expect(h.sent).toEqual([{ content: "keep going", options: { expandPromptTemplates: true } }]);
	});

	it("re-sends the swallowed prompt when the compaction fails", () => {
		const h = harness();
		coldSession(h);
		h.run("input", input());
		h.compactions[0]?.onError?.(new Error("Nothing to compact (session too small)"));
		expect(h.sent).toEqual([{ content: "keep going", options: { expandPromptTemplates: true } }]);
	});

	it("re-sends images as content blocks", () => {
		const h = harness();
		coldSession(h);
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		h.run("input", input({ images: [image] }));
		h.compactions[0]?.onComplete?.();
		expect(h.sent[0]?.content).toEqual([{ type: "text", text: "keep going" }, image]);
	});

	it("ignores the prompt it re-sent", () => {
		const h = harness();
		coldSession(h);
		h.run("input", input());
		h.compactions[0]?.onComplete?.();
		h.sent.length = 0;
		expect(h.run("input", input({ source: "extension" }))).toBeUndefined();
		expect(h.compactions.length).toBe(1);
		expect(h.sent).toEqual([]);
	});

	it("passes the prompt through when compact() throws", () => {
		const h = harness();
		coldSession(h);
		h.compactThrows = true;
		expect(h.run("input", input())).toBeUndefined();
		expect(h.sent).toEqual([]);
		h.compactThrows = false;
		expect(h.run("input", input())).toBeUndefined();
		expect(h.compactions).toEqual([]);
	});

	it("passes a prompt when the last turn settled recently", () => {
		const h = harness();
		h.branch = [user("ask", NOW - 60_000), assistant(NOW - 30_000)];
		h.run("session_start", { type: "session_start" });
		expect(h.run("input", input())).toBeUndefined();
		expect(h.compactions).toEqual([]);
	});

	it("takes the first prompt after a session is restored cold", () => {
		const h = harness();
		coldSession(h);
		expect(h.run("input", input())).toEqual({ action: "handled" });
	});

	it("does not take a second prompt while the compaction holds", () => {
		const h = harness();
		coldSession(h);
		h.run("input", input());
		expect(h.run("input", input({ text: "another" }))).toBeUndefined();
		expect(h.compactions.length).toBe(1);
	});

	it("takes again once the run settles", () => {
		const h = harness();
		coldSession(h);
		h.run("input", input());
		h.compactions[0]?.onComplete?.();
		h.run("agent_settled", { type: "agent_settled" });
		expect(h.compactions.length).toBe(1);
		h.run("agent_settled", { type: "agent_settled" });
		expect(h.run("input", input({ text: "later" }))).toBeUndefined();
	});
});

describe("config", () => {
	it("exposes the policy the guards read", () => {
		expect(limits(IDLE_COMPACT_CONFIG)).toEqual({
			enabled: true,
			idleMs: 3_600_000,
			minTokens: 40_000,
		});
	});
});
