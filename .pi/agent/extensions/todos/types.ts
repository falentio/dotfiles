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
import { TODO_OPERATIONS, type TodoOperation } from "./operations.ts";

const stringEnum = <const V extends readonly string[]>(
	values: V,
	options?: Annotations<V[number]>,
): Schema<V[number]> => ({ type: "string", ...oneOf(values, options) });

export const TODO_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"abandoned",
	"blocked",
] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];
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

/**
 * Result details. The list itself lives only in the `todo_snapshot` entry: a
 * second durable copy in the tool result can disagree with the snapshot after
 * a rewind.
 */
export interface TodoToolDetails {
	/** Operation that produced this snapshot; absent on legacy transcript entries. */
	op?: TodoOperation;
	storage: "session" | "memory";
	completedTasks?: TodoCompletionTransition[];
}

const TodoOp = stringEnum(TODO_OPERATIONS, {
	description: "operation to apply",
});

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
