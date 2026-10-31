/**
 * Replace pi's summary compaction with the DSH algorithm: prune tool results in place while the
 * projection is under pressure, and drop the oldest span instead of asking a model to transcribe
 * it. No provider call is made, and the retained window stays verbatim so its prompt cache survives.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONFIG,
	pruneBudget,
	pruneGate,
	shouldPrune,
	validateConfig,
	type HarnessCompactionConfig,
} from "./config.ts";
import { pruneContent } from "./prune.ts";

export default function harnessCompaction(pi: ExtensionAPI, config: HarnessCompactionConfig = CONFIG) {
	validateConfig(config);
	const budget = pruneBudget(config);

	pi.on("context", (event, ctx) => {
		const usage = ctx.getContextUsage();
		if (!usage || !shouldPrune(config, usage)) return;

		let pruned = 0;
		for (const message of event.messages) {
			if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
			const content = pruneContent(message.content, budget);
			if (!content) continue;
			message.content = content;
			pruned++;
		}
		// Mutating the projection in place is the supported form; the empty result carries no replacement list.
		if (pruned > 0) return {};
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
			const gate = Math.round(pruneGate(config, window));
			const pressure =
				usage?.tokens == null
					? "no token count since the last compaction"
					: `${usage.tokens} of ${window} tokens, gate ${gate}`;
			ctx.ui.notify(
				`harness-compaction ${config.enabled ? "on" : "off"}: ${pressure}; prune tool results over ${config.thresholdChars} code points to ${config.headChars} head, ${config.tailChars} tail`,
				"info",
			);
		},
	});
}
