/**
 * Nested AGENTS.md, on the fly.
 *
 * When a tool touches a file, inject the context files that govern that file's directory but sit
 * below the working directory. cwd and its ancestors are already in the system prompt, so only
 * deeper files are injected, and only once per content revision.
 *
 * The guarantee: the same file is never injected twice into one session, including across a resume
 * in a new process and across a compaction. Two mechanisms provide it:
 *
 *   1. identity dedup. Files are keyed by canonical (realpath) identity, so one file reached through
 *      two logical paths is one record.
 *   2. rebuild, never merge. The delivered map is REPLACED on session_start and session_compact from
 *      the transcript itself: our marker entries plus the injected blocks still present in tool
 *      results. A fresh process starts from the transcript, not from empty, and a compaction that
 *      drops a marker still leaves the block to be found.
 *
 * All rules live in ./logic.ts and are unit-tested by ./logic.test.ts. This file is the wiring.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	ENTRY_TYPE,
	TRIGGER_TOOLS,
	collectDelivered,
	renderInstructions,
	selectDeliveries,
} from "./logic.ts";

export default function nestedAgents(pi: ExtensionAPI) {
	/** canonical identity -> content hash already delivered to the model */
	let delivered = new Map<string, string>();

	/**
	 * Rebuild from scratch. Replacing rather than merging is what makes a new process safe: a stale
	 * in-memory entry cannot survive, and a transcript that no longer carries a file's block cannot
	 * suppress re-injection. Rebuilt from the compaction-aware view, which is what the model sees.
	 */
	const rebuildFromTranscript = (ctx: { sessionManager: { buildContextEntries(): readonly unknown[] } }) => {
		delivered = collectDelivered(ctx.sessionManager.buildContextEntries());
	};

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromTranscript(ctx);
	});

	// A compaction rewrites the transcript and can drop the marker entries for files whose blocks it
	// kept, or drop both. Rebuilding afterwards re-arms anything no longer provably present.
	pi.on("session_compact", async (_event, ctx) => {
		rebuildFromTranscript(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!TRIGGER_TOOLS.has(event.toolName)) return;

		const fresh = selectDeliveries(event.input, ctx.cwd, delivered);
		if (fresh.length === 0) return;
		for (const { path: file, id, hash } of fresh) {
			delivered.set(id, hash);
			pi.appendEntry(ENTRY_TYPE, { path: file, id, hash });
		}

		return {
			content: [...event.content, { type: "text" as const, text: renderInstructions(fresh) }],
		};
	});
}
