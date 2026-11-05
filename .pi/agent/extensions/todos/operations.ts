/** Source for the description table, the schema enum, and `TodoOperation`. */

export const TODO_OP_ROWS = [
	{ op: "init", effect: "Create or replace the plan; phased `list` or flat `items`" },
	{ op: "start", effect: "Mark in progress" },
	{
		op: "done",
		effect:
			"Mark completed; `phase` alone completes that phase's open tasks; omit both for every open task",
	},
	{ op: "drop", effect: "Mark abandoned; omit both for every task" },
	{
		op: "block",
		effect: "Keep open, waiting on external input; skips the stop-time reminder",
	},
	{ op: "unblock", effect: "Back to `pending`" },
	{ op: "rm", effect: "Remove a task or phase; omit both to clear the plan" },
	{ op: "append", effect: "Add tasks to a phase, creating it if needed" },
	{ op: "update", effect: "Rename, move, or reorder; keeps status" },
	{ op: "view", effect: "Read-only; echo the plan" },
] as const;

export type TodoOperation = (typeof TODO_OP_ROWS)[number]["op"];
export const TODO_OPERATIONS = [...new Set(TODO_OP_ROWS.map((row) => row.op))];
