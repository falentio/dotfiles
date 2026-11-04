/**
 * Prompt text for the todo tool and the tracker's injected messages.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/prompts/tools/todo.md`,
 * `src/prompts/system/eager-todo.md`, and
 * `src/prompts/system/mid-run-todo-nudge.md` (Handlebars templates flattened
 * to plain template functions — the extension cannot rely on omp's prompt
 * renderer).
 */

import { TODO_OP_ROWS } from "./operations.ts";

export interface EagerTodoContext {
	/** Wire name of the todo tool (normally "todo"). */
	toolRef: string;
	/** Whether the eager mode is "always" (MUST-call) vs "preferred". */
	forced: boolean;
}

/** First-turn eager todo prelude (`todo.eager: "preferred" | "always"`). */
export function renderEagerTodoPrompt(context: EagerTodoContext): string {
	const { toolRef, forced } = context;
	if (forced) {
		return (
			`<system-reminder>\n` +
			`Before substantive work, create a phased todo.\n\n` +
			`You MUST call \`${toolRef}\` first in this turn.\n` +
			`You MUST initialize the todo list with a single \`init\` op.\n` +
			`You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.\n` +
			`Task descriptions MUST be concise, specific 5-10 word labels.\n` +
			`The \`init\` op only accepts phase names and task-label strings; do not invent task metadata fields.\n\n` +
			`After \`${toolRef}\` succeeds, continue the request in the same turn.\n` +
			`NEVER call \`${toolRef}\` again unless task state has materially changed.\n` +
			`</system-reminder>`
		);
	}
	return (
		`<system-reminder>\n` +
		`Consider calling \`${toolRef}\` first to lay out a phased plan with a single \`init\` op. A good list covers the whole request — investigation through implementation and verification — not just the next step, with specific task descriptions a future turn could execute without re-planning.\n` +
		`A useful list keeps each task to a concise, specific 5-10 word label; the \`init\` op only accepts phase names and task-label strings, so don't invent extra task metadata fields.\n` +
		`If you create the list, continue the request in the same turn and avoid re-calling \`${toolRef}\` unless task state materially changes.\n` +
		`</system-reminder>`
	);
}

export interface MidRunNudgeContext {
	/** Wire name of the todo tool (normally "todo"). */
	toolRef: string;
	incompleteCount: number;
}

/** Hidden mid-run nudge injected after many mutating tool results. */
export function renderMidRunNudgePrompt(context: MidRunNudgeContext): string {
	const { toolRef, incompleteCount } = context;
	const plural = incompleteCount !== 1;
	return (
		`<system-reminder>\n` +
		`${incompleteCount} todo item${plural ? "s" : ""} still open. If you finished a task since last \`${toolRef}\` update, mark it done now so progress stays visible; otherwise keep working.\n` +
		`</system-reminder>`
	);
}

function renderOperationTable(): string {
	const rows = TODO_OP_ROWS.map(
		(row) => `|\`${row.op}\`|${row.fields}|${row.effect}|`,
	);
	return ["|\`op\`|Fields|Effect|", "|---|---|---|", ...rows].join("\n");
}

/** The todo tool's description (what the model sees in the tools section). */
export const TODO_TOOL_DESCRIPTION = `**Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in \`task\`.**

Auto-promote only fires when NOTHING is in progress: completing a task with none in progress promotes the earliest open task (phase order) to \`in_progress\`; an existing in-progress task keeps its place. Completed tasks NEVER revert; out-of-order work may point back to an earlier phase, which is expected.

## Operations

${renderOperationTable()}

## Anatomy

- Task: 5-10 words, unique. Phase: short noun phrase, no numbering.

## Rules

- Mark tasks done immediately after finishing; complete phases in order.
- Batch todo calls with real work (\`init\` with first reads, each \`done\`/\`start\` with the next action); a solo todo turn wastes a round trip.
- Stuck on external input: \`block\` with \`reason\`, \`unblock\` when actionable; if the blocker is agent-actionable, \`append\` an unblocking task.
- Keep introduced \`task\`/\`phase\` strings stable. \`view\` echoes the list; never guess task text from memory.

## Create a list

- Task requires 3+ distinct steps.
- User explicitly requests one.
- User provides a set of tasks.
- New instructions arrive mid-task: capture before proceeding.
- For an N-item plan, create one task per item.`;
