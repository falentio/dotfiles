/**
 * Pure todo state operations — no I/O, no session access.
 *
 * Ported from Oh My Pi's `packages/coding-agent/src/tools/todo.ts`
 * (state helpers section).
 */

import { compile } from "@earendil-works/pi-schema";
import { TODO_OPERATIONS, type TodoOperation } from "./operations.ts";
import {
	TODO_STATUSES,
	todoSchema,
	type TodoCompletionTransition,
	type TodoItem,
	type TodoParams,
	type TodoPhase,
	type TodoStatus,
} from "./types.ts";

const todoValidator = compile(todoSchema);

function findTaskByContent(
	phases: TodoPhase[],
	content: string,
): { task: TodoItem; phase: TodoPhase } | undefined {
	for (const phase of phases) {
		const task = phase.tasks.find((t) => t.content === content);
		if (task) return { task, phase };
	}
	return undefined;
}

function findPhaseByName(
	phases: TodoPhase[],
	name: string,
): TodoPhase | undefined {
	return phases.find((phase) => phase.name === name);
}

export function cloneTask(task: TodoItem): TodoItem {
	return { ...task };
}

/** Drop phases with no tasks, so an emptied list holds no phases at all. */
export function pruneEmptyPhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.filter((phase) => phase.tasks.length > 0);
}

export function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.map(cloneTask),
	}));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

export interface TodoStatusChange {
	phase: string;
	content: string;
	from: TodoStatus;
	to: TodoStatus;
}

export function getStatusChanges(
	previous: TodoPhase[],
	updated: TodoPhase[],
): TodoStatusChange[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of phase.tasks) {
			previousStatuses.set(
				todoTransitionKey(phase.name, task.content),
				task.status,
			);
		}
	}

	const changes: TodoStatusChange[] = [];
	for (const phase of updated) {
		for (const task of phase.tasks) {
			const from = previousStatuses.get(
				todoTransitionKey(phase.name, task.content),
			);
			if (from !== undefined && from !== task.status) {
				changes.push({
					phase: phase.name,
					content: task.content,
					from,
					to: task.status,
				});
			}
		}
	}
	return changes;
}

export function getCompletionTransitions(
	previous: TodoPhase[],
	updated: TodoPhase[],
): TodoCompletionTransition[] {
	return getStatusChanges(previous, updated)
		.filter((change) => change.to === "completed" && change.from !== "completed")
		.map(({ phase, content }) => ({ phase, content }));
}

export function normalizeInProgressTask(phases: TodoPhase[]): void {
	const orderedTasks = phases.flatMap((phase) => phase.tasks);
	if (orderedTasks.length === 0) return;

	const inProgressTasks = orderedTasks.filter(
		(task) => task.status === "in_progress",
	);
	if (inProgressTasks.length > 1) {
		for (const task of inProgressTasks.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressTasks.length > 0) return;

	const firstPendingTask = orderedTasks.find(
		(task) => task.status === "pending",
	);
	if (firstPendingTask) firstPendingTask.status = "in_progress";
}

/** Whether an unknown value is a persisted todo phase. */
export function isTodoPhase(value: unknown): value is TodoPhase {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !Array.isArray(record.tasks))
		return false;
	return record.tasks.every((task) => {
		if (typeof task !== "object" || task === null) return false;
		const candidate = task as Record<string, unknown>;
		if (typeof candidate.content !== "string") return false;
		if (!TODO_STATUSES.some((status) => status === candidate.status)) return false;
		return (
			candidate.blocker === undefined ||
			typeof candidate.blocker === "string"
		);
	});
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): { task: TodoItem; phase: TodoPhase } | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce(
				(sum, phase) => sum + phase.tasks.length,
				0,
			);
			const hint =
				totalTasks === 0
					? " (todo list is empty — was it replaced or not yet created?)"
					: "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(
	phases: TodoPhase[],
	name: string | undefined,
	errors: string[],
): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function getTaskTargets(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoItem[] {
	// Branch on `!== undefined`, not truthiness: an explicitly supplied empty
	// target must resolve (and error) as such — with truthiness `""` silently
	// falls through to the "omit both = everything" path, turning
	// `{op:"rm", task:""}` into "delete every task".
	if (entry.task !== undefined) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? [hit.task] : [];
	}
	if (entry.phase !== undefined) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? [...phase.tasks] : [];
	}
	return phases.flatMap((phase) => phase.tasks);
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

/**
 * Collapse whitespace runs (incl. newlines) to single spaces — the same
 * one-line guarantee the `block` op gives `reason`. Task content and phase
 * names ride on single lines everywhere downstream: the summary text, and the
 * task identity that targeting ops match by. Normalizing at this boundary
 * keeps every consumer one-line-safe without touching identity.
 */
export function normalizeSingleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

const TODO_MARKER_PATTERN =
	/<!--[ \t]*todo:[ \t]*([a-z_]+)[ \t]*"([^"\n]*)"[ \t]*-->/g;

export interface TodoMarkerExtraction {
	/** The reply text with every applied marker stripped. */
	text: string;
	marked: string[];
	unsupported: string[];
}

/** Extract <!-- todo: done "…" --> markers; a fenced code block is skipped. */
export function extractTodoMarkers(text: string): TodoMarkerExtraction {
	const marked: string[] = [];
	const unsupported: string[] = [];
	const lines: string[] = [];
	let inFence = false;
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("```")) {
			inFence = !inFence;
			lines.push(line);
			continue;
		}
		if (inFence) {
			lines.push(line);
			continue;
		}
		const before = marked.length;
		let kept = line.replace(
			TODO_MARKER_PATTERN,
			(raw: string, op: string, content: string) => {
				if (op !== "done") {
					unsupported.push(content);
					return raw;
				}
				marked.push(content);
				return "";
			},
		);
		if (marked.length > before) {
			if (kept.trim() === "") continue;
			kept = kept.replace(/ {2,}/g, " ");
		}
		lines.push(kept);
	}
	return { text: lines.join("\n"), marked, unsupported };
}

function initPhases(entry: TodoParams, errors: string[]): TodoPhase[] {
	const list =
		entry.list ??
		(entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	const normalized: Array<{ phase: string; items: string[] }> = [];
	for (const listEntry of list) {
		const phaseName = normalizeSingleLine(listEntry.phase);
		if (!phaseName) {
			errors.push("Empty phase name in init list");
			continue;
		}
		if (seenPhases.has(phaseName)) {
			errors.push(`Duplicate phase "${phaseName}" in init list`);
		}
		seenPhases.add(phaseName);
		const items: string[] = [];
		for (const rawContent of listEntry.items) {
			const content = normalizeSingleLine(rawContent);
			if (!content) {
				errors.push("Empty task content in init list");
				continue;
			}
			if (seenTasks.has(content)) {
				errors.push(`Duplicate task "${content}" in init list`);
			}
			seenTasks.add(content);
			items.push(content);
		}
		normalized.push({ phase: phaseName, items });
	}
	return normalized.map((listEntry) => ({
		name: listEntry.phase,
		tasks: listEntry.items.map<TodoItem>((content) => ({
			content,
			status: "pending",
		})),
	}));
}

function appendItems(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	const phaseName = entry.phase !== undefined ? normalizeSingleLine(entry.phase) : "";
	if (!phaseName) {
		errors.push("Missing phase name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}
	const normalizedItems = entry.items.map(normalizeSingleLine);
	if (normalizedItems.some((content) => !content)) {
		errors.push("Empty task content in append items");
		return phases;
	}

	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const content of normalizedItems) {
		if (seen.has(content) || findTaskByContent(phases, content)) {
			errors.push(`Task "${content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(content);
	}
	if (hasDuplicate) return phases;
	let phase = findPhaseByName(phases, phaseName);
	if (!phase) {
		phase = { name: phaseName, tasks: [] };
		phases.push(phase);
	}

	for (const content of normalizedItems) {
		phase.tasks.push({ content, status: "pending" });
	}
	return phases;
}

function updateTask(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	const hit = resolveTaskOrError(phases, entry.task, errors);
	if (!hit) return phases;
	if (
		entry.content === undefined &&
		entry.phase === undefined &&
		entry.before === undefined
	) {
		errors.push("update requires content, phase, or before");
		return phases;
	}
	const target = hit.task;
	const content =
		entry.content !== undefined
			? normalizeSingleLine(entry.content)
			: target.content;
	if (!content) {
		errors.push("Empty task content in update");
		return phases;
	}
	if (content !== target.content && findTaskByContent(phases, content)) {
		errors.push(`Task "${content}" already exists`);
		return phases;
	}
	const phaseName =
		entry.phase !== undefined ? normalizeSingleLine(entry.phase) : hit.phase.name;
	if (!phaseName) {
		errors.push("Missing phase name for update operation");
		return phases;
	}
	let destination = findPhaseByName(phases, phaseName);
	if (!destination) {
		destination = { name: phaseName, tasks: [] };
		phases.push(destination);
	}
	const beforeContent =
		entry.before !== undefined ? normalizeSingleLine(entry.before) : undefined;
	if (
		beforeContent !== undefined &&
		!destination.tasks.some(
			(task) => task !== target && task.content === beforeContent,
		)
	) {
		errors.push(`Task "${beforeContent}" not found in phase "${phaseName}"`);
		return phases;
	}
	if (beforeContent === undefined && destination === hit.phase) {
		target.content = content;
		return phases;
	}
	hit.phase.tasks = hit.phase.tasks.filter((task) => task !== target);
	target.content = content;
	if (beforeContent === undefined) {
		destination.tasks.push(target);
	} else {
		const index = destination.tasks.findIndex(
			(task) => task.content === beforeContent,
		);
		destination.tasks.splice(index, 0, target);
	}
	return phases;
}

function removeTasks(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	if (entry.task !== undefined) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		hit.phase.tasks = hit.phase.tasks.filter(
			(candidate) => candidate !== hit.task,
		);
		return phases;
	}
	if (entry.phase !== undefined) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(
	phases: TodoPhase[],
	entry: TodoParams,
	errors: string[],
): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			for (const phase of phases) {
				for (const candidate of phase.tasks) {
					if (candidate.status === "in_progress" && candidate !== hit.task) {
						candidate.status = "pending";
					}
				}
			}
			hit.task.status = "in_progress";
			return phases;
		}
		case "done": {
			const openOnly = entry.task === undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (
					openOnly &&
					task.status !== "pending" &&
					task.status !== "in_progress"
				)
					continue;
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
			if (entry.task === undefined && entry.phase === undefined) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one summary line, so an embedded newline from a
			// multi-line external error or user question would corrupt the rendered
			// line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (
					task.status !== "pending" &&
					task.status !== "in_progress" &&
					task.status !== "blocked"
				)
					continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (entry.task === undefined && entry.phase === undefined) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					delete task.blocker;
				}
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "update":
			return updateTask(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
export function inferTodoOp(
	args: Record<string, unknown>,
	hasExistingPhases: boolean,
): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if (typeof args.phase === "string" && args.phase) return "append";
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerce the argument shapes models send into the schema's shape; only unambiguous repairs. */
export function normalizeTodoArgs(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	const args: Record<string, unknown> = { ...raw };
	if (
		Array.isArray(args.list) &&
		args.list.length > 0 &&
		args.list.every((entry) => typeof entry === "string")
	) {
		args.items = args.list;
		delete args.list;
	} else if (isRecord(args.list)) {
		const entries = Object.entries(args.list);
		if (
			entries.length > 0 &&
			entries.every(([, items]) => Array.isArray(items))
		) {
			args.list = entries.map(([phase, items]) => ({ phase, items }));
		}
	}
	if (Array.isArray(args.list)) {
		args.list = args.list.flatMap((entry) => {
			if (!isRecord(entry)) return [entry];
			const next: Record<string, unknown> = { ...entry };
			if (next.phase === undefined && typeof next.name === "string") {
				next.phase = next.name;
			}
			if (typeof next.items === "string") next.items = [next.items];
			if (Array.isArray(next.items) && next.items.length === 0) return [];
			return [next];
		});
	}
	if (args.op !== undefined && !TODO_OPERATIONS.some((op) => op === args.op)) {
		delete args.op;
	}
	return args;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool's
 * `prepareArguments` shim repairs a missing `op` alongside an unambiguous
 * payload (models routinely send `{list:[...]}` with no op) before schema
 * validation; this re-validates at execute time as defense in depth.
 * Anything else returns the schema error text for a normal model retry.
 */
export function resolveTodoParams(
	raw: unknown,
	hasExistingPhases: boolean,
): TodoParams | string {
	const normalized = normalizeTodoArgs(raw);
	if (todoValidator.check(normalized)) return normalized;
	if (isRecord(normalized) && normalized.op === undefined) {
		const inferred = inferTodoOp(normalized, hasExistingPhases);
		if (inferred) {
			const repaired = { ...normalized, op: inferred };
			if (todoValidator.check(repaired)) return repaired;
		}
	}
	const summary = todoValidator.errors(normalized)
		.map((error) => `${error.path || "(root)"}: ${error.message}`)
		.join("; ");
	return `Invalid todo arguments: ${summary}`;
}

export function applyParams(
	phases: TodoPhase[],
	params: TodoParams,
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = pruneEmptyPhases(applyEntry(phases, params, errors));
	normalizeInProgressTask(next);
	return { phases: next, errors };
}
