import { describe, expect, it } from "bun:test";
import {
	estimateTokens,
	sessionEntryToContextMessages,
	type CompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { planPrecompute, tailTokensFrom } from "../boundary.ts";

type AgentMessage = Extract<SessionEntry, { type: "message" }>["message"];

interface OraclePreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	previousSummary?: string;
}

interface OracleModule {
	prepareCompaction(
		entries: SessionEntry[],
		settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
	): OraclePreparation | undefined;
}

const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const oracle = (await import(new URL("core/compaction/compaction.js", packageEntry).href)) as OracleModule;

const MODEL = "mock/fixture";

let nextId = 0;

function entryOf(message: AgentMessage): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `e${nextId}`,
		parentId: null,
		timestamp: new Date(1_700_000_000_000 + nextId).toISOString(),
		message,
	};
}

function user(text: string): SessionEntry {
	return entryOf({ role: "user", content: [{ type: "text", text }], timestamp: nextId });
}

function assistant(text: string): SessionEntry {
	return entryOf({
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
	});
}

function toolResult(text: string): SessionEntry {
	return entryOf({
		role: "toolResult",
		toolCallId: `call-${nextId}`,
		toolName: "bloat",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: nextId,
	});
}

function compaction(summary: string, firstKeptEntryId: string): CompactionEntry {
	nextId += 1;
	return {
		type: "compaction",
		id: `e${nextId}`,
		parentId: null,
		timestamp: new Date(1_700_000_000_000 + nextId).toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 0,
	};
}

function turn(text: string): SessionEntry[] {
	return [user(`${text} question`), assistant(`${text} answer`)];
}

function fixture(name: string, entries: SessionEntry[], keepRecentTokens: number): Fixture {
	return { name, entries, keepRecentTokens };
}

interface Fixture {
	name: string;
	entries: SessionEntry[];
	keepRecentTokens: number;
}

const small = 4;
const completeTurn = turn("one");
const fiveTurns = [...turn("one"), ...turn("two"), ...turn("three"), ...turn("four"), ...turn("five")];
const keptTail = completeTurn[1]!;
const afterCompaction = [
	...turn("old one"),
	...turn("old two"),
	keptTail,
	compaction("earlier summary", keptTail.id),
	...turn("new"),
];
const largeTurn = [user("large"), assistant("a".repeat(4_000)), toolResult("b".repeat(4_000)), assistant("done")];

const fixtures: Fixture[] = [
	fixture("empty branch", [], 20_000),
	fixture("one user message", [user("hello")], 20_000),
	fixture("one complete turn", completeTurn, small),
	fixture("one complete turn with a budget above the history", completeTurn, 1_000_000),
	fixture("five turns cutting inside the last turn", fiveTurns, 3),
	fixture("five turns with a budget above the history", fiveTurns, 1_000_000),
	fixture("branch after a compaction", afterCompaction, 2),
	fixture("branch after a compaction with a missing keep id", [
		...turn("old one"),
		...turn("old two"),
		compaction("earlier summary", "missing-entry"),
		...turn("new"),
	], 8),
	fixture("single turn larger than the budget", largeTurn, 10),
];

function oraclePlan(f: Fixture): OraclePreparation | undefined {
	return oracle.prepareCompaction(f.entries, {
		enabled: true,
		reserveTokens: 16_384,
		keepRecentTokens: f.keepRecentTokens,
	});
}

describe("planPrecompute against pi's prepareCompaction", () => {
	for (const f of fixtures) {
		const plan = planPrecompute(f.entries, f.keepRecentTokens, MODEL);
		const expected = oraclePlan(f);

		it(`matches the cut point: ${f.name}`, () => {
			expect(plan?.keepEntryId).toBe(expected?.firstKeptEntryId);
		});

		it(`matches the definition of an empty plan: ${f.name}`, () => {
			expect(plan === undefined).toBe(expected === undefined);
		});

		if (plan && expected) {
			it(`covers the same messages: ${f.name}`, () => {
				expect(plan.messages.length).toBe(
					expected.messagesToSummarize.length + expected.turnPrefixMessages.length,
				);
				expect(plan.coveredEntryIds.length).toBe(plan.messages.length);
			});

			it(`keeps a valid cut point: ${f.name}`, () => {
				const keep = f.entries.find((entry) => entry.id === plan.keepEntryId);
				expect(keep).toBeDefined();
				expect(keep).not.toBeUndefined();
				if (!keep) return;
				expect(keep.type).not.toBe("compaction");
				const messages = sessionEntryToContextMessages(keep);
				expect(messages.length).toBeGreaterThan(0);
				expect(messages.every((message) => message.role !== "toolResult")).toBe(true);
			});

			it(`carries the plan metadata: ${f.name}`, () => {
				expect(plan.modelRef).toBe(MODEL);
				expect(plan.previousSummary).toBe(expected.previousSummary);
				expect(tailTokensFrom(f.entries, plan.keepEntryId)).toBe(plan.tailTokens);
			});
		}
	}
});

describe("tailTokensFrom", () => {
	it("sums estimates from the keep entry to the branch head", () => {
		const entries = fiveTurns;
		const keep = entries[6]!;
		const expected = entries
			.slice(6)
			.flatMap((entry) => sessionEntryToContextMessages(entry))
			.reduce((sum, message) => sum + estimateTokens(message), 0);
		expect(tailTokensFrom(entries, keep.id)).toBe(expected);
	});

	it("returns undefined when the keep entry left the branch", () => {
		expect(tailTokensFrom(fiveTurns, "missing")).toBeUndefined();
	});

	it("counts the keep entry itself", () => {
		const last = fiveTurns[fiveTurns.length - 1]!;
		expect(tailTokensFrom([last], last.id)).toBe(estimateTokens(sessionEntryToContextMessages(last)[0]!));
	});
});
