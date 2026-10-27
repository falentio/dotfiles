import {
	generateSummaryWithUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { planPrecompute, tailTokensFrom, type Plan } from "./boundary.ts";
import {
	PRECOMPUTE_CONFIG,
	ceiling,
	gate,
	limits,
	validateConfig,
	type Limits,
	type PrecomputeConfig,
} from "./config.ts";
import {
	advance,
	initialState,
	judge,
	recordSummaryFailure,
	type SessionState,
	type Snapshot,
	type Usage,
} from "./state.ts";

type Model = NonNullable<ExtensionContext["model"]>;

export interface SummaryRequest {
	readonly messages: Plan["messages"];
	readonly model: Model;
	readonly reserveTokens: number;
	readonly apiKey: string | undefined;
	readonly headers: Record<string, string> | undefined;
	readonly signal: AbortSignal;
	readonly customInstructions: string | undefined;
	readonly previousSummary: string | undefined;
	readonly thinkingLevel: ExtensionContext["thinkingLevel"];
}

export type Summarize = (request: SummaryRequest) => Promise<{ text: string; usage: Usage }>;

export interface BackgroundCompactionDeps {
	readonly summarize: Summarize;
}

const defaultSummarize: Summarize = (request) =>
	generateSummaryWithUsage(
		[...request.messages],
		request.model,
		request.reserveTokens,
		request.apiKey,
		request.headers,
		request.signal,
		request.customInstructions,
		request.previousSummary,
		request.thinkingLevel,
	);

export function createBackgroundCompaction(
	config: PrecomputeConfig = PRECOMPUTE_CONFIG,
	deps: BackgroundCompactionDeps = { summarize: defaultSummarize },
): (pi: ExtensionAPI) => void {
	validateConfig(config);
	const policy = limits(config);
	return (pi) => install(pi, config, policy, deps.summarize);
}

function install(
	pi: ExtensionAPI,
	config: PrecomputeConfig,
	policy: Limits,
	summarize: Summarize,
): void {
	let state = initialState();
	let compactScheduled = false;
	let compactionCallIssued = false;

	function resetTracking(): void {
		compactScheduled = false;
		compactionCallIssued = false;
	}

	function abortRunning(): void {
		if (state.precompute.status === "running") state.precompute.abort.abort();
	}

	function setStatus(ctx: ExtensionContext): void {
		if (!config.enabled) return;
		ctx.ui.setStatus("precompute", statusFor(state.precompute.status));
	}

	function reset(ctx: ExtensionContext): void {
		abortRunning();
		resetTracking();
		state = initialState();
		setStatus(ctx);
	}

	function snapshotOf(ctx: ExtensionContext): Snapshot {
		const usage = ctx.getContextUsage();
		const branch = ctx.sessionManager.getBranch();
		return {
			idle: ctx.isIdle(),
			hasPendingMessages: ctx.hasPendingMessages(),
			tokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
			branch,
			modelRef: modelRefOf(ctx.model),
			userMessageSinceCompaction: userMessageAfterCompaction(branch),
		};
	}

	function runAdvance(ctx: ExtensionContext): void {
		const action = advance(state, snapshotOf(ctx), policy);
		if (action.kind === "start") {
			void startSummary(ctx, action.plan);
			return;
		}
		if (action.kind === "compact") {
			scheduleCompact(ctx);
			return;
		}
		if (action.kind === "drop") {
			state = { ...state, precompute: { status: "idle" } };
			setStatus(ctx);
		}
	}

	async function startSummary(ctx: ExtensionContext, plan: Plan): Promise<void> {
		if (!config.enabled || ctx.model === undefined) return;
		if (state.precompute.status !== "idle" && state.precompute.status !== "failed") return;

		const abort = new AbortController();
		state = { ...state, precompute: { status: "running", plan, abort } };
		setStatus(ctx);

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (abort.signal.aborted) return;
		if (!auth.ok || !auth.apiKey) {
			state = recordSummaryFailure(state, plan, "hard", config.maxFailures);
			setStatus(ctx);
			return;
		}

		let result: { text: string; usage: Usage };
		try {
			result = await summarize({
				messages: plan.messages,
				model: ctx.model,
				reserveTokens: config.reserveTokens,
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: abort.signal,
				customInstructions: undefined,
				previousSummary: plan.previousSummary,
				thinkingLevel: ctx.thinkingLevel,
			});
		} catch {
			if (abort.signal.aborted) return;
			state = recordSummaryFailure(state, plan, "rejected", config.maxFailures);
			setStatus(ctx);
			return;
		}

		if (abort.signal.aborted) return;
		const summary = result.text.trim();
		if (summary.length === 0) {
			state = recordSummaryFailure(state, plan, "rejected", config.maxFailures);
			setStatus(ctx);
			return;
		}

		state = { ...state, precompute: { status: "ready", plan, summary, usage: result.usage } };
		setStatus(ctx);
		runAdvance(ctx);
	}

	function scheduleCompact(ctx: ExtensionContext): void {
		if (compactScheduled || compactionCallIssued) return;
		compactScheduled = true;
		setTimeout(() => {
			compactScheduled = false;
			if (compactionCallIssued) return;
			if (state.precompute.status !== "ready") return;
			if (!ctx.isIdle() || ctx.hasPendingMessages()) return;

			compactionCallIssued = true;
			ctx.compact({
				onComplete: () => {
					compactionCallIssued = false;
				},
				onError: () => {
					compactionCallIssued = false;
					state = {
						...state,
						precompute: { status: "failed" },
						failures: state.failures + 1,
					};
					setStatus(ctx);
				},
			});
		}, 0);
	}

	function report(ctx: ExtensionContext): string {
		const usage = ctx.getContextUsage();
		const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
		const held =
			state.precompute.status === "running" || state.precompute.status === "ready"
				? state.precompute.plan
				: undefined;
		const keepId = held?.keepEntryId;
		const tailTokens = held ? (tailTokensFrom(ctx.sessionManager.getBranch(), held.keepEntryId) ?? held.tailTokens) : 0;

		return [
			`precompute ${state.precompute.status}`,
			`tokens ${usage?.tokens ?? "unknown"}`,
			`gate ${gate(contextWindow, config)}`,
			`ceiling ${ceiling(contextWindow, config)}`,
			`keep ${keepId ? keepId.slice(0, 8) : "none"}`,
			`tail ${tailTokens}`,
			`failures ${state.failures}`,
		].join("; ");
	}

	pi.on("session_start", (_event, ctx) => {
		reset(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		runAdvance(ctx);
	});

	pi.on("session_before_compact", (event, ctx) => {
		if (!config.enabled || state.precompute.status !== "ready") return;
		const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
		const baseTail = policy.tail(contextWindow);
		const tailLimit = event.willRetry ? Math.min(baseTail, policy.keepRecentTokens) : baseTail;
		const verdict = judge({
			precompute: state.precompute,
			branch: event.branchEntries,
			modelRef: modelRefOf(ctx.model),
			customInstructions: event.customInstructions,
			previousSummary: event.preparation.previousSummary,
			tailLimit,
		});
		if (verdict.kind === "skip") return;

		if (compactionCallIssued) {
			state = { ...state, precompute: { status: "compacting" } };
			setStatus(ctx);
		}
		return {
			compaction: {
				summary: verdict.summary,
				firstKeptEntryId: verdict.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				usage: verdict.usage,
			},
		};
	});

	pi.on("session_compact", (_event, ctx) => {
		reset(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (state.precompute.status !== "running" && state.precompute.status !== "ready") return;
		reset(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		reset(ctx);
	});

	pi.registerCommand("precompute", {
		description: "Report or force the background compaction precompute",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const branch = ctx.sessionManager.getBranch();
			const canForce =
				trimmed === "force" &&
				config.enabled &&
				ctx.isIdle() &&
				!ctx.hasPendingMessages() &&
				userMessageAfterCompaction(branch) &&
				(state.precompute.status === "idle" || state.precompute.status === "failed");

			if (canForce && ctx.model) {
				const plan = planPrecompute(
					branch,
					policy.keepRecentTokens,
					modelRefOf(ctx.model) ?? "",
				);
				if (plan) void startSummary(ctx, plan);
			}

			ctx.ui.notify(report(ctx), "info");
		},
	});
}

function statusFor(status: SessionState["precompute"]["status"]): string | undefined {
	switch (status) {
		case "idle":
			return undefined;
		case "running":
			return "precompute: summarizing...";
		case "ready":
			return "precompute: summary ready";
		case "compacting":
			return "precompute: compacting...";
		case "failed":
			return "precompute: summary failed";
		default: {
			const exhaustive: never = status;
			return exhaustive;
		}
	}
}

function modelRefOf(model: Model | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

function userMessageAfterCompaction(branch: readonly SessionEntry[]): boolean {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}

	for (let i = compactionIndex + 1; i < branch.length; i++) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "user") return true;
	}
	if (compactionIndex >= 0) return false;

	return branch.some((entry) => entry.type === "message" && entry.message.role === "user");
}

export default function backgroundCompaction(pi: ExtensionAPI): void {
	createBackgroundCompaction()(pi);
}
