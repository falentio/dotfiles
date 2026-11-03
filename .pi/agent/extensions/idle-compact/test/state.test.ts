import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { IDLE_COMPACT_CONFIG, limits, type IdleCompactConfig } from "../config.ts";
import { decide, settledAtFrom, type Decision, type Input, type Phase, type Prompt } from "../state.ts";

const NOW = 1_800_000_000_000;
const policy = limits(IDLE_COMPACT_CONFIG);
const stale: Phase = { kind: "watching", settledAt: NOW - policy.idleMs };
const idleInput: Input = {
	text: "keep going",
	source: "interactive",
	streaming: false,
	pendingMessages: false,
	tokens: 100_000,
};

function taken(decision: Decision): Prompt {
	if (decision.kind !== "take") throw new Error(`expected take, got ${decision.kind}`);
	return decision.prompt;
}

describe("decide", () => {
	it("takes a stale, large, idle interactive prompt", () => {
		const prompt = taken(decide(stale, idleInput, policy, NOW));
		expect(prompt.text).toBe("keep going");
		expect(prompt.images).toBeUndefined();
	});

	it("carries images through the take", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const prompt = taken(decide(stale, { ...idleInput, images: [image] }, policy, NOW));
		expect(prompt.images).toEqual([image]);
	});

	it("passes a prompt that arrived before idleMs elapsed", () => {
		expect(decide({ kind: "watching", settledAt: NOW - 1_000 }, idleInput, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes a prompt below minTokens", () => {
		expect(decide(stale, { ...idleInput, tokens: policy.minTokens - 1 }, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes a prompt whose token count is unknown", () => {
		expect(decide(stale, { ...idleInput, tokens: null }, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes a streaming prompt", () => {
		expect(decide(stale, { ...idleInput, streaming: true }, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes a prompt while messages are pending", () => {
		expect(decide(stale, { ...idleInput, pendingMessages: true }, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes a prompt another extension re-sent", () => {
		expect(decide(stale, { ...idleInput, source: "extension" }, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes a prompt that arrives while compacting", () => {
		const compacting: Phase = { kind: "compacting", prompt: { text: "first" } };
		expect(decide(compacting, idleInput, policy, NOW)).toEqual({ kind: "pass" });
	});

	it("passes every prompt when disabled", () => {
		const disabled: IdleCompactConfig = { ...IDLE_COMPACT_CONFIG, enabled: false };
		expect(decide(stale, idleInput, limits(disabled), NOW)).toEqual({ kind: "pass" });
	});

	it("passes a blank prompt", () => {
		expect(decide(stale, { ...idleInput, text: "  \n\t " }, policy, NOW)).toEqual({ kind: "pass" });
	});
});

describe("settledAtFrom", () => {
	it("returns the timestamp of the newest assistant message", () => {
		const branch = [user("ask", 1_700_000_000_000), assistant("answer", 1_700_000_060_000), user("again", 1_700_000_120_000)];
		expect(settledAtFrom(branch, NOW)).toBe(1_700_000_060_000);
	});

	it("returns now for a branch with no assistant message", () => {
		expect(settledAtFrom([], NOW)).toBe(NOW);
		expect(settledAtFrom([user("ask", 1_700_000_000_000)], NOW)).toBe(NOW);
	});
});

let nextId = 0;

function user(text: string, at: number): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `u${nextId}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: { role: "user", content: [{ type: "text", text }], timestamp: at },
	};
}

function assistant(text: string, at: number): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `a${nextId}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
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
			timestamp: at,
		},
	};
}
