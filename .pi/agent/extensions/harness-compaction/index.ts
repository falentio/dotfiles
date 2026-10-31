/**
 * Replace pi's summary compaction with the DeepSeek Harness (DSH) algorithm: shrink an oversized
 * tool result before it is stored, keep shrinking the projection while a request is over the gate,
 * and drop the oldest span instead of asking a model to transcribe it. The drop path makes no
 * provider call, and the retained window stays verbatim so its prompt cache survives.
 */
import {
	estimateTokens,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CONFIG,
	pruneBudget,
	pruneGate,
	reserveTokensFor,
	shouldPrune,
	validateConfig,
	type HarnessCompactionConfig,
} from "./config.ts";
import { pruneContent } from "./prune.ts";

export default function harnessCompaction(pi: ExtensionAPI, config: HarnessCompactionConfig = CONFIG) {
	validateConfig(config);
	const budget = pruneBudget(config);

	const reserveFor = (ctx: ExtensionContext): number =>
		reserveTokensFor(pi.getSettings().compaction, ctx.model);

	pi.on("tool_result", (event, ctx) => {
		if (!config.enabled) return;
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens === null) return;

		const pending = {
			role: "toolResult" as const,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			content: event.content,
			isError: event.isError,
			timestamp: Date.now(),
		};
		// pi checks its trigger after this result is stored, so the result that would cross the gate
		// has to shrink now. A check that already fired reports no token count, which is why the
		// comparison looks forward instead of reading the projection.
		if (usage.tokens + estimateTokens(pending) <= pruneGate(config, usage.contextWindow, reserveFor(ctx))) return;

		const content = pruneContent(event.content, budget);
		// Replacing the content drops structured content pi can no longer trust, but the tool's own
		// details still describe it.
		return content ? { content, details: event.details } : undefined;
	});

	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || !shouldPrune(config, usage, reserveFor(ctx))) return;

		for (const message of event.messages) {
			if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
			const content = pruneContent(message.content, budget);
			if (content) message.content = content;
		}
	});

	pi.on("session_before_compact", (event) => {
		if (!config.enabled || event.customInstructions) return;
		return {
			compaction: {
				summary: config.droppedHistoryNote,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		};
	});

	pi.registerCommand("harness-compaction", {
		description: "Report the prune gate, current context usage, and settings",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? 0;
			const reserve = reserveFor(ctx);
			const gate = Math.round(pruneGate(config, window, reserve));
			const pressure =
				usage?.tokens == null
					? `no token count since the last compaction, gate ${gate}`
					: `${usage.tokens} of ${window} tokens, gate ${gate}`;
			ctx.ui.notify(
				`harness-compaction ${config.enabled ? "on" : "off"}: ${pressure}, pi reserve ${reserve}; prune tool results over ${config.thresholdChars} code points to ${config.headChars} head, ${config.tailChars} tail`,
				"info",
			);
		},
	});
}
