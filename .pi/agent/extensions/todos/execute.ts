/**
 * The todo tool's execute semantics as a pure function, so the exact omp
 * behavior (batch atomicity, completion transitions, error summaries) can be
 * unit-tested without a live pi session. The extension's `execute` wires this
 * into `ToolDefinition.execute` and throws when `failed` (pi's error signal).
 */

import { formatSummary, type SummaryContext } from "./format.ts";
import {
	applyParams,
	clonePhases,
	getCompletionTransitions,
	getStatusChanges,
	resolveTodoParams,
	type TodoStatusChange,
} from "./state.ts";
import type { TodoOperation } from "./operations.ts";
import type {
	TodoCompletionTransition,
	TodoItem,
	TodoParams,
	TodoPhase,
	TodoStatus,
} from "./types.ts";

export interface TodoExecuteOutcome {
	/** Operation that produced this snapshot. */
	op: TodoOperation;
	/** Effective phases after the op (previous on failure or read-only view). */
	phases: TodoPhase[];
	/** Tasks that transitioned to completed in this update. */
	completedTasks: TodoCompletionTransition[];
	/** Text summary for the model. */
	summary: string;
	/** A batch failed wholesale — nothing was applied. */
	failed: boolean;
	/** Whether this was a pure read. */
	readOnly: boolean;
	/** Storage classification: "session" when a session file exists, else "memory". */
	storage: "session" | "memory";
}

export interface TodoExecuteOptions {
	/** True when the session has a file (`"session"` storage). */
	hasSessionFile: boolean;
	/** Return the full list for a status op too (after a compaction). */
	forceFullList?: boolean;
}

/** Ops whose result is a delta; every other op returns the full list. */
const DELTA_OPS: ReadonlySet<TodoOperation> = new Set([
	"done",
	"start",
	"drop",
	"block",
	"unblock",
]);

const MAX_CHANGE_NAMES = 6;

const CHANGE_LABELS: Record<TodoStatus, string> = {
	pending: "Unblocked",
	in_progress: "Started",
	completed: "Marked done",
	abandoned: "Dropped",
	blocked: "Blocked",
};

function taskFor(
	phases: TodoPhase[],
	change: TodoStatusChange,
): TodoItem | undefined {
	return phases
		.find((phase) => phase.name === change.phase)
		?.tasks.find((task) => task.content === change.content);
}

function changeNames(changes: TodoStatusChange[]): string {
	const shown = changes.slice(0, MAX_CHANGE_NAMES);
	const more = changes.length - shown.length;
	const names = shown.map((change) => `"${change.content}"`).join(", ");
	return more > 0 ? `${names} (+${more} more)` : names;
}

function blockedChangeLine(
	group: TodoStatusChange[],
	phases: TodoPhase[],
): string {
	if (group.length > 1) return `Blocked: ${changeNames(group)}`;
	const change = group[0];
	if (!change) return "";
	const reason = taskFor(phases, change)?.blocker;
	const where = `"${change.content}" (${change.phase})`;
	return reason ? `Blocked ${where}: ${reason}.` : `Blocked ${where}`;
}

function renderStatusChanges(
	changes: TodoStatusChange[],
	phases: TodoPhase[],
): string[] {
	const groups = new Map<TodoStatus, TodoStatusChange[]>();
	for (const change of changes) {
		const group = groups.get(change.to) ?? [];
		group.push(change);
		groups.set(change.to, group);
	}
	const lines: string[] = [];
	for (const [to, group] of groups) {
		lines.push(
			to === "blocked"
				? blockedChangeLine(group, phases)
				: `${CHANGE_LABELS[to]}: ${changeNames(group)}`,
		);
	}
	return lines;
}

/**
 * `start` demotes the previous in-progress task, and every other status op
 * auto-promotes the next one. Neither is a change the call made, and the Next
 * line already reports the promoted task.
 */
function relevantChanges(
	op: TodoOperation,
	changes: TodoStatusChange[],
): TodoStatusChange[] {
	return changes.filter((change) => {
		if (change.to === "pending") return op === "unblock";
		if (change.to === "in_progress") return op === "start";
		return true;
	});
}

/**
 * Apply a single todo op with full omp semantics:
 *
 * 1. `resolveTodoParams` re-validates and repairs a missing `op`.
 * 2. `view` is a pure read: no normalization, no state write.
 * 3. A batch with any error is discarded wholesale: persisting a half-applied
 *    batch makes the natural retry hit "already exists" for the ops that did
 *    land. State and rendered summary stay at previous.
 *
 * @param previous Current phases (defensive clone taken internally).
 * @param rawParams Raw tool call arguments (already schema-validated in pi,
 *                  but re-validated here for the lenient path).
 * @param options Session storage and the post-compaction full-list override.
 */
export function executeTodoOp(
	previous: TodoPhase[],
	rawParams: unknown,
	options: TodoExecuteOptions,
): TodoExecuteOutcome {
	const { hasSessionFile, forceFullList = false } = options;
	const previousPhases = clonePhases(previous);
	const storage = hasSessionFile ? "session" : "memory";
	const resolved = resolveTodoParams(rawParams, previousPhases.length > 0);
	if (typeof resolved === "string") {
		return {
			op: "view",
			phases: previousPhases,
			completedTasks: [],
			summary: formatSummary(previousPhases, [resolved], { mode: "full" }),
			failed: true,
			readOnly: false,
			storage,
		};
	}
	const entry: TodoParams = resolved;
	const op = entry.op;
	const readOnly = op === "view";
	const { phases: updated, errors } = readOnly
		? { phases: previousPhases, errors: [] as string[] }
		: applyParams(clonePhases(previousPhases), entry);
	const failed = errors.length > 0;
	const effective = failed ? previousPhases : updated;
	const completedTasks =
		readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
	const changes =
		readOnly || failed
			? []
			: renderStatusChanges(
					relevantChanges(op, getStatusChanges(previousPhases, updated)),
					updated,
				);
	const mode: SummaryContext["mode"] =
		failed || forceFullList || !DELTA_OPS.has(op) ? "full" : "delta";
	return {
		op,
		phases: effective,
		completedTasks,
		summary: formatSummary(effective, errors, { mode, readOnly, changes }),
		failed,
		readOnly,
		storage,
	};
}
