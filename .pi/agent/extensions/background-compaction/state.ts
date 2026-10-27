import type { CompactionResult, SessionEntry } from "@earendil-works/pi-coding-agent";
import { planPrecompute, tailTokensFrom, type Plan } from "./boundary.ts";
import type { Limits } from "./config.ts";

export type Usage = NonNullable<CompactionResult["usage"]>;

export type Precompute =
	| { readonly status: "idle" }
	| { readonly status: "running"; readonly plan: Plan; readonly abort: AbortController }
	| { readonly status: "ready"; readonly plan: Plan; readonly summary: string; readonly usage?: Usage }
	| { readonly status: "compacting" }
	| { readonly status: "failed" };

export interface SessionState {
	readonly precompute: Precompute;
	readonly failures: number;
	readonly lastFailedKeepId: string | null;
}

export type SkipReason =
	| "not-ready"
	| "custom-instructions"
	| "model-changed"
	| "baseline-changed"
	| "branch-changed"
	| "tail-too-big";

export type Verdict =
	| { readonly kind: "use"; readonly summary: string; readonly firstKeptEntryId: string; readonly usage?: Usage }
	| { readonly kind: "skip"; readonly reason: SkipReason };

export type Action =
	| { readonly kind: "start"; readonly plan: Plan }
	| { readonly kind: "compact" }
	| { readonly kind: "drop"; readonly reason: SkipReason }
	| { readonly kind: "wait" };

export interface Snapshot {
	readonly idle: boolean;
	readonly hasPendingMessages: boolean;
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly branch: readonly SessionEntry[];
	readonly modelRef: string | undefined;
	readonly userMessageSinceCompaction: boolean;
}

export function judge(input: {
	readonly precompute: Precompute;
	readonly branch: readonly SessionEntry[];
	readonly modelRef: string | undefined;
	readonly customInstructions: string | undefined;
	readonly previousSummary: string | undefined;
	readonly tailLimit: number;
}): Verdict {
	const held = input.precompute;
	if (held.status !== "ready") return { kind: "skip", reason: "not-ready" };
	if (input.customInstructions && input.customInstructions.trim().length > 0) {
		return { kind: "skip", reason: "custom-instructions" };
	}
	const plan = held.plan;
	if (input.modelRef !== plan.modelRef) return { kind: "skip", reason: "model-changed" };
	if (input.previousSummary !== plan.previousSummary) return { kind: "skip", reason: "baseline-changed" };

	const firstCovered = plan.coveredEntryIds[0];
	if (firstCovered === undefined || !hasEntry(input.branch, firstCovered)) {
		return { kind: "skip", reason: "branch-changed" };
	}

	let previousIndex = -1;
	for (const id of plan.coveredEntryIds) {
		const index = input.branch.findIndex((entry) => entry.id === id);
		if (index < 0 || index <= previousIndex) return { kind: "skip", reason: "branch-changed" };
		previousIndex = index;
	}

	const tailTokens = tailTokensFrom(input.branch, plan.keepEntryId);
	if (tailTokens === undefined) return { kind: "skip", reason: "branch-changed" };
	if (tailTokens > input.tailLimit) return { kind: "skip", reason: "tail-too-big" };

	return {
		kind: "use",
		summary: held.summary,
		firstKeptEntryId: plan.keepEntryId,
		usage: held.usage,
	};
}

export function advance(state: SessionState, snapshot: Snapshot, limits: Limits): Action {
	if (!limits.enabled) return { kind: "wait" };
	if (!snapshot.idle || snapshot.hasPendingMessages) return { kind: "wait" };
	if (state.precompute.status === "running" || state.precompute.status === "compacting") {
		return { kind: "wait" };
	}

	if (state.precompute.status === "ready") {
		const verdict = judge({
			precompute: state.precompute,
			branch: snapshot.branch,
			modelRef: snapshot.modelRef,
			customInstructions: undefined,
			previousSummary: previousSummaryFromBranch(snapshot.branch),
			tailLimit: limits.tail(snapshot.contextWindow),
		});
		if (verdict.kind === "skip") return { kind: "drop", reason: verdict.reason };
		return limits.compactWhenReady ? { kind: "compact" } : { kind: "wait" };
	}

	if (state.precompute.status === "failed" && state.failures >= limits.maxFailures) {
		return { kind: "wait" };
	}
	if (snapshot.tokens === null) return { kind: "wait" };

	const ceiling = snapshot.contextWindow - limits.reserveTokens;
	if (ceiling < limits.minCeilingTokens) return { kind: "wait" };
	const gate = Math.floor(limits.compactAtRatio * ceiling);
	if (snapshot.tokens < gate) return { kind: "wait" };
	if (!snapshot.userMessageSinceCompaction) return { kind: "wait" };

	const plan =
		snapshot.modelRef === undefined
			? undefined
			: planPrecompute(snapshot.branch, limits.keepRecentTokens, snapshot.modelRef);
	if (state.failures > 0 && plan !== undefined && state.lastFailedKeepId === plan.keepEntryId) {
		return { kind: "wait" };
	}
	if (plan === undefined) return { kind: "wait" };
	return { kind: "start", plan };
}

export function initialState(): SessionState {
	return { precompute: { status: "idle" }, failures: 0, lastFailedKeepId: null };
}

export function recordSummaryFailure(
	state: SessionState,
	plan: Plan,
	kind: "rejected" | "hard",
	maxFailures: number,
): SessionState {
	if (state.precompute.status !== "running") return state;
	return {
		precompute: { status: "failed" },
		failures: kind === "hard" ? maxFailures : state.failures + 1,
		lastFailedKeepId: plan.keepEntryId,
	};
}

function hasEntry(branch: readonly SessionEntry[], id: string): boolean {
	return branch.some((entry) => entry.id === id);
}

function previousSummaryFromBranch(branch: readonly SessionEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "compaction") return entry.summary;
	}
	return undefined;
}
