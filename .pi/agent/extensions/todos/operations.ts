/**
 * The `todo` tool's operation table.
 *
 * The tool description renders these rows, and both the schema enum and the
 * `TodoOperation` union derive from them, so an operation is declared once.
 * Both prose cells are markdown.
 */

export const TODO_OP_ROWS = [
	{
		op: "init",
		fields: "`list: [{phase, items: string[]}]`",
		effect: "Initialize full list; replaces existing",
	},
	{
		op: "init",
		fields: "`items: string[]`",
		effect: "Flattened single-phase init",
	},
	{
		op: "start",
		fields: "`task`",
		effect: "Mark in progress",
	},
	{
		op: "done",
		fields: "`task` or `phase`",
		effect: "Mark completed; omit both to mark every task",
	},
	{
		op: "drop",
		fields: "`task` or `phase`",
		effect: "Mark abandoned; omit both to mark every task",
	},
	{
		op: "block",
		fields: "`task` or `phase`; optional `reason`",
		effect:
			"Mark blocked: open, awaiting external input; excluded from stop-time incomplete-todo reminder",
	},
	{
		op: "unblock",
		fields: "`task` or `phase`",
		effect: "Blocked task → `pending`",
	},
	{
		op: "rm",
		fields: "optional `task` or `phase`",
		effect: "Remove a task or phase; omit both to clear the list",
	},
	{
		op: "append",
		fields: "`phase`; `items: string[]`",
		effect: "Append tasks to phase; lazily creates phase",
	},
	{
		op: "view",
		fields: "—",
		effect: "Read-only; echo list",
	},
] as const;

export type TodoOperation = (typeof TODO_OP_ROWS)[number]["op"];
export const TODO_OPERATIONS = [...new Set(TODO_OP_ROWS.map((row) => row.op))];
