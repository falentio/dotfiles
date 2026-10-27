import { describe, expect, it } from "bun:test";
import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PRECOMPUTE_CONFIG, gate as gateFor, limits, type Limits, type PrecomputeConfig } from "../config.ts";
import type { Plan } from "../boundary.ts";
import {
	advance,
	initialState,
	judge,
	recordSummaryFailure,
	type Precompute,
	type SessionState,
	type SkipReason,
	type Snapshot,
	type Usage,
} from "../state.ts";

type AgentMessage = Extract<SessionEntry, { type: "message" }>["message"];

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

function compaction(summary: string, firstKeptEntryId: string): CompactionEntry {
	nextId += 1;
	return {
		type: "compaction",
		id: `c${nextId}`,
		parentId: null,
		timestamp: new Date(1_700_000_000_000 + nextId).toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 0,
	};
}

const usage: Usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const branch = [user("u".repeat(40)), assistant("a".repeat(40))];
const covered = branch[0]!;
const keep = branch[1]!;

const basePlan: Plan = {
	coveredEntryIds: [covered.id],
	keepEntryId: keep.id,
	messages: [messageOf(covered)],
	previousSummary: undefined,
	modelRef: "mock/model",
	tailTokens: 10,
};

function messageOf(entry: SessionEntry): AgentMessage {
	if (entry.type !== "message") throw new Error("expected a message entry");
	return entry.message;
}

function ready(plan: Plan = basePlan, summary = "summary text", withUsage = false): Precompute {
	return withUsage
		? { status: "ready", plan, summary, usage }
		: { status: "ready", plan, summary };
}

function makeLimits(overrides: Partial<Limits> = {}): Limits {
	return {
		...limits({ ...PRECOMPUTE_CONFIG, keepRecentTokens: 4 }),
		tail: () => 40_000,
		...overrides,
	};
}

function config(overrides: Partial<PrecomputeConfig> = {}): PrecomputeConfig {
	return { ...PRECOMPUTE_CONFIG, keepRecentTokens: 4, ...overrides };
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
	return { ...initialState(), ...overrides };
}

const gate = gateFor(200_000);

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		idle: true,
		hasPendingMessages: false,
		tokens: gate,
		contextWindow: 200_000,
		branch,
		modelRef: "mock/model",
		userMessageSinceCompaction: true,
		...overrides,
	};
}

describe("judge", () => {
	const defaults: Parameters<typeof judge>[0] = {
		precompute: ready(),
		branch,
		modelRef: "mock/model",
		customInstructions: undefined,
		previousSummary: undefined,
		tailLimit: 1_000,
	};

	it("uses the summary and pins the keep entry", () => {
		expect(judge(defaults)).toEqual({
			kind: "use",
			summary: "summary text",
			firstKeptEntryId: keep.id,
			usage: undefined,
		});
	});

	it("returns the held usage", () => {
		const verdict = judge({ ...defaults, precompute: ready(basePlan, "summary text", true) });
		expect(verdict.kind).toBe("use");
		if (verdict.kind !== "use") return;
		expect(verdict.usage).toEqual(usage);
	});

	const rows: Array<[string, Partial<Parameters<typeof judge>[0]>, SkipReason | "use"]> = [
		["idle is not ready", { precompute: { status: "idle" } }, "not-ready"],
		["failed is not ready", { precompute: { status: "failed" } }, "not-ready"],
		["compacting is not ready", { precompute: { status: "compacting" } }, "not-ready"],
		["running is not ready", {
			precompute: { status: "running", plan: basePlan, abort: new AbortController() },
		}, "not-ready"],
		["custom instructions win over every later rule", {
			customInstructions: "  focus on auth  ",
			modelRef: "other/model",
		}, "custom-instructions"],
		["whitespace instructions are ignored", { customInstructions: "   " }, "use"],
		["empty instructions are ignored", { customInstructions: "" }, "use"],
		["a model change drops the summary", { modelRef: "other/model" }, "model-changed"],
		["a missing current model drops the summary", { modelRef: undefined }, "model-changed"],
		["a new baseline summary drops the summary", { previousSummary: "different" }, "baseline-changed"],
		["a removed baseline summary drops the summary", {
			precompute: ready({ ...basePlan, previousSummary: "old" }),
			previousSummary: undefined,
		}, "baseline-changed"],
		["the first covered id missing drops the summary", {
			precompute: ready({ ...basePlan, coveredEntryIds: ["missing"] }),
		}, "branch-changed"],
		["a later covered id missing drops the summary", {
			precompute: ready({ ...basePlan, coveredEntryIds: [covered.id, "missing"] }),
		}, "branch-changed"],
		["covered ids out of order drop the summary", {
			precompute: ready({ ...basePlan, coveredEntryIds: [keep.id, covered.id] }),
		}, "branch-changed"],
		["a missing keep entry drops the summary", {
			precompute: ready({ ...basePlan, keepEntryId: "missing" }),
		}, "branch-changed"],
		["a tail above the limit drops the summary", { tailLimit: 5 }, "tail-too-big"],
		["a tail at the limit is used", { tailLimit: 10 }, "use"],
	];

	for (const [name, overrides, expected] of rows) {
		it(name, () => {
			const verdict = judge({ ...defaults, ...overrides });
			if (expected === "use") {
				expect(verdict.kind).toBe("use");
				return;
			}
			expect(verdict).toEqual({ kind: "skip", reason: expected });
		});
	}

	it("treats a matching baseline summary as unchanged", () => {
		const withBaseline = ready({ ...basePlan, previousSummary: "old" });
		expect(judge({ ...defaults, precompute: withBaseline, previousSummary: "old" }).kind).toBe("use");
	});

	it("detects the keep entry after a new compaction on the branch", () => {
		const withCompaction = [...branch, compaction("new baseline", covered.id)];
		expect(
			judge({ ...defaults, branch: withCompaction, previousSummary: "new baseline" }),
		).toEqual({ kind: "skip", reason: "baseline-changed" });
	});
});

describe("advance", () => {
	it("starts from a quiet, gated, grown session", () => {
		const action = advance(makeState(), snapshot(), makeLimits());
		expect(action.kind).toBe("start");
		if (action.kind !== "start") return;
		expect(action.plan.keepEntryId).toBe(keep.id);
	});

	const waits: Array<[string, SessionState, Snapshot, Limits]> = [
		["disabled config", makeState(), snapshot(), makeLimits({ enabled: false })],
		["a busy agent", makeState(), snapshot({ idle: false }), makeLimits()],
		["pending messages", makeState(), snapshot({ hasPendingMessages: true }), makeLimits()],
		["a running summary", makeState({
			precompute: { status: "running", plan: basePlan, abort: new AbortController() },
		}), snapshot(), makeLimits()],
		["a compaction in flight", makeState({ precompute: { status: "compacting" } }), snapshot(), makeLimits()],
		["a failed budget", makeState({ precompute: { status: "failed" }, failures: 2 }), snapshot(), makeLimits()],
		["a null token count", makeState(), snapshot({ tokens: null }), makeLimits()],
		["a ceiling below the floor", makeState(), snapshot({ contextWindow: 80_000, tokens: 60_000 }), makeLimits()],
		["tokens below the gate", makeState(), snapshot({ tokens: gate - 1 }), makeLimits()],
		["no user message after the latest compaction", makeState(), snapshot({ userMessageSinceCompaction: false }), makeLimits()],
		["no model reference", makeState(), snapshot({ modelRef: undefined }), makeLimits()],
		["no plan for the branch", makeState(), snapshot(), makeLimits({ keepRecentTokens: 1_000_000 })],
		["a retry on the same keep entry", makeState({
			precompute: { status: "failed" },
			failures: 1,
			lastFailedKeepId: keep.id,
		}), snapshot(), makeLimits()],
	];

	for (const [name, state, snap, limit] of waits) {
		it(`waits on ${name}`, () => {
			expect(advance(state, snap, limit)).toEqual({ kind: "wait" });
		});
	}

	it("starts at the gate boundary", () => {
		expect(advance(makeState(), snapshot({ tokens: gate }), makeLimits()).kind).toBe("start");
	});

	it("retries on a different keep entry", () => {
		const action = advance(
			makeState({ precompute: { status: "failed" }, failures: 1, lastFailedKeepId: "older" }),
			snapshot(),
			makeLimits(),
		);
		expect(action.kind).toBe("start");
	});

	it("compacts a ready summary when the session is quiet", () => {
		expect(advance(makeState({ precompute: ready() }), snapshot(), makeLimits())).toEqual({ kind: "compact" });
	});

	it("never compacts when compactWhenReady is false", () => {
		expect(advance(makeState({ precompute: ready() }), snapshot(), makeLimits({ compactWhenReady: false }))).toEqual({
			kind: "wait",
		});
	});

	it("drops a stale tail instead of compacting", () => {
		expect(
			advance(makeState({ precompute: ready() }), snapshot(), makeLimits({ tail: () => 5 })),
		).toEqual({ kind: "drop", reason: "tail-too-big" });
	});

	it("drops a summary after a model change", () => {
		expect(
			advance(makeState({ precompute: ready() }), snapshot({ modelRef: "other/model" }), makeLimits()),
		).toEqual({ kind: "drop", reason: "model-changed" });
	});

	it("never starts while a summary is running, ready, or compacting", () => {
		const states: Precompute[] = [
			{ status: "running", plan: basePlan, abort: new AbortController() },
			ready(),
			{ status: "compacting" },
		];
		for (const precompute of states) {
			expect(advance(makeState({ precompute }), snapshot(), makeLimits()).kind).not.toBe("start");
		}
	});

	it("never compacts unless the judge says use", () => {
		const changed = snapshot({ modelRef: "other/model" });
		expect(advance(makeState({ precompute: ready() }), changed, makeLimits()).kind).not.toBe("compact");
	});

	it("never starts below the gate with the real config", () => {
		const limit = limits({ ...PRECOMPUTE_CONFIG, keepRecentTokens: 4 });
		expect(advance(makeState(), snapshot({ tokens: gate - 1 }), limit)).toEqual({ kind: "wait" });
		expect(advance(makeState(), snapshot({ tokens: gate }), limit).kind).toBe("start");
	});
});

describe("recordSummaryFailure", () => {
	const running = makeState({
		precompute: { status: "running", plan: basePlan, abort: new AbortController() },
	});

	it("leaves failed, never running", () => {
		const next = recordSummaryFailure(running, basePlan, "rejected", 2);
		expect(next.precompute.status).toBe("failed");
		expect(next.failures).toBe(1);
		expect(next.lastFailedKeepId).toBe(keep.id);
	});

	it("exhausts the budget on a hard failure", () => {
		const next = recordSummaryFailure(running, basePlan, "hard", 2);
		expect(next.precompute.status).toBe("failed");
		expect(next.failures).toBe(2);
	});

	it("keeps counting rejected attempts up to the budget", () => {
		const first = recordSummaryFailure(running, basePlan, "rejected", 2);
		const second = recordSummaryFailure(
			{ ...first, precompute: { status: "running", plan: basePlan, abort: new AbortController() } },
			basePlan,
			"rejected",
			2,
		);
		expect(second.failures).toBe(2);
		expect(second.precompute.status).toBe("failed");
	});

	it("ignores a rejection outside the running state", () => {
		const idle = makeState();
		expect(recordSummaryFailure(idle, basePlan, "rejected", 2)).toEqual(idle);
	});
});

describe("invalid limits typing is impossible", () => {
	it("limits exposes the frozen policy fields and the derived functions", () => {
		const value = limits(config());
		expect(Object.keys(value).sort()).toEqual([
			"ceiling",
			"compactWhenReady",
			"enabled",
			"gate",
			"keepRecentTokens",
			"maxFailures",
			"minCeilingTokens",
			"tail",
		]);
	});
});
