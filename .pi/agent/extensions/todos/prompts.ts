/**
 * Prompt text for the todo tool and the tracker's injected messages.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/prompts/tools/todo.md`,
 * `src/prompts/system/eager-todo.md`, and
 * `src/prompts/system/mid-run-todo-nudge.md` (Handlebars templates flattened
 * to plain template functions; the extension cannot rely on omp's prompt
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
			`Before other work, lay out the plan with one \`${toolRef}\` init call: phases covering the whole request, investigation through verification, one 5-10 word task per item. Then continue the request in the same turn.\n` +
			`</system-reminder>`
		);
	}
	return (
		`<system-reminder>\n` +
		`For a request with several steps, lay out the plan first with one \`${toolRef}\` init call: phases and one 5-10 word task per item, detailed enough that a later turn can execute each task without re-planning. Then continue the request in the same turn.\n` +
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
	const { incompleteCount } = context;
	const plural = incompleteCount !== 1;
	return (
		`<system-reminder>\n` +
		`${incompleteCount} task${plural ? "s" : ""} still open. If one just landed, write <!-- todo: done "exact task" --> in your reply.\n` +
		`</system-reminder>`
	);
}

function renderOperationTable(): string {
	const rows = TODO_OP_ROWS.map((row) => `|\`${row.op}\`|${row.effect}|`);
	return [`|\`op\`|Effect|`, "|---|---|", ...rows].join("\n");
}

/** The todo tool's description (what the model sees in the tools section). */
export const TODO_TOOL_DESCRIPTION = `Track a phased plan. Tasks are addressed by their exact text: pass it in \`task\`. That label is the handle for \`done\`, \`drop\`, \`block\`, and \`update\`.

## Operations

${renderOperationTable()}

## Rules

- Mark a task done the moment its check passes. When a turn is ending, do it from the reply: \`<!-- todo: done "exact task" -->\`. No tool call.
- Revise the plan with \`update\`; \`init\` replaces it.
- \`done\` promotes the next open task to \`in_progress\`.

## Create a plan

For 3+ steps, a plan the user gives, or one that arrives mid-task. Phase: short noun phrase. Task: 5-10 words, unique. One task per item.`;
