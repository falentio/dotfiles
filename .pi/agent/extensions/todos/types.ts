/**
 * Todo types and the pi-schema JSON Schema for the `todo` tool.
 */

import {
	arr,
	obj,
	oneOf,
	opt,
	str,
	type Annotations,
	type Schema,
	type Static,
} from "@earendil-works/pi-schema";

const stringEnum = <const V extends readonly string[]>(
	values: V,
	options?: Annotations<V[number]>,
): Schema<V[number]> => ({ type: "string", ...oneOf(values, options) });

export type TodoStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "abandoned"
	| "blocked";
/** Operation names accepted by the todo tool and echoed in successful result details. */
export type TodoOperation =
	| "init"
	| "start"
	| "done"
	| "rm"
	| "drop"
	| "block"
	| "unblock"
	| "append"
	| "view";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export interface TodoCompletionTransition {
	phase: string;
	content: string;
}

export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	phases: TodoPhase[];
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
}

const TodoOp = stringEnum(
	[
		"init",
		"start",
		"done",
		"rm",
		"drop",
		"block",
		"unblock",
		"append",
		"view",
	],
	{ description: "operation to apply" },
);

const InitListEntry = obj(
	{
		phase: str({ description: "phase name" }),
		items: arr(str({ description: "task content" }), {
			minItems: 1,
			description: "tasks for this phase",
		}),
	},
	{ open: true },
);

export const todoSchema = obj(
	{
		op: TodoOp,
		list: opt(
			arr(InitListEntry, { description: "phased task list (init)" }),
		),
		task: opt(str({ description: "task content" })),
		phase: opt(str({ description: "phase name" })),
		// No `minItems` here: `items` is only meaningful for `init`/`append`,
		// and both enforce non-empty with op-specific errors. A stray `items: []` on
		// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
		items: opt(
			arr(str({ description: "task content" }), {
				description: "tasks to append",
			}),
		),
		reason: opt(str({ description: "blocker note (block op)" })),
	},
	{ open: true, description: "apply a single todo operation" },
);

export type TodoParams = Static<typeof todoSchema>;
