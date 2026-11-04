/**
 * Text summary returned to the model after every todo operation.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts`
 * (`formatSummary`), split into a full list and the delta a status op returns.
 */

import type { TodoItem, TodoPhase } from "./types.ts";

export interface SummaryContext {
	mode: "full" | "delta";
	readOnly?: boolean;
	/** Lines describing what this call changed, e.g. Marked done: "X". */
	changes?: string[];
}

function isOpen(task: TodoItem): boolean {
	return task.status === "pending" || task.status === "in_progress";
}

function isClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

function overallLine(phases: TodoPhase[]): string {
	const tasks = phases.flatMap((phase) => phase.tasks);
	const closed = tasks.filter(isClosed).length;
	const open = tasks.filter(isOpen).length;
	const blocked = tasks.filter((task) => task.status === "blocked").length;
	return `Overall: ${closed}/${tasks.length} done, ${open} open${blocked > 0 ? `, ${blocked} blocked` : ""}.`;
}

const WORKED_AHEAD_SUFFIX =
	" — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed).";

function activePhaseLine(phases: TodoPhase[]): string {
	let index = phases.findIndex((phase) => phase.tasks.some(isOpen));
	if (index === -1) index = phases.length - 1;
	const current = phases[index];
	if (!current) return "";
	const done = current.tasks.filter(isClosed).length;
	const workedAhead = phases.some(
		(phase, idx) => idx > index && phase.tasks.some(isClosed),
	);
	return `Active phase ${index + 1}/${phases.length} "${current.name}" (${done}/${current.tasks.length})${workedAhead ? WORKED_AHEAD_SUFFIX : "."}`;
}

function nextLine(phases: TodoPhase[]): string {
	for (const phase of phases) {
		const task = phase.tasks.find(isOpen);
		if (task) return `Next: "${task.content}" [${task.status}] (${phase.name})`;
	}
	return "Next: none.";
}

function closedCounts(done: number, dropped: number): string {
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (dropped > 0) parts.push(`${dropped} dropped`);
	return `(${parts.join(", ")})`;
}

function phaseBlocks(phases: TodoPhase[]): string[] {
	const lines: string[] = [];
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		for (const task of phase.tasks.filter(isOpen)) {
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "blocked"
						? task.blocker
							? ` (blocked: ${task.blocker})`
							: " (blocked)"
						: "";
			lines.push(`    - ${task.content}${tag}`);
		}
		const done = phase.tasks.filter((task) => task.status === "completed").length;
		const dropped = phase.tasks.filter(
			(task) => task.status === "abandoned",
		).length;
		if (done > 0 || dropped > 0) {
			lines.push(`    ${closedCounts(done, dropped)}`);
		}
	}
	return lines;
}

export function formatSummary(
	phases: TodoPhase[],
	errors: string[],
	context: SummaryContext,
): string {
	const tasks = phases.flatMap((phase) => phase.tasks);
	if (tasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return context.readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (context.changes) lines.push(...context.changes);
	if (context.mode === "delta") {
		lines.push(nextLine(phases), overallLine(phases), activePhaseLine(phases));
	} else {
		lines.push(
			overallLine(phases),
			activePhaseLine(phases),
			...phaseBlocks(phases),
		);
	}
	return lines.filter((line) => line.length > 0).join("\n");
}
