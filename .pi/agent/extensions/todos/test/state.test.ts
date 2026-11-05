import { describe, expect, it } from "bun:test";
import {
	getCompletionTransitions,
	inferTodoOp,
	normalizeInProgressTask,
	normalizeTodoArgs,
} from "../state.ts";
import { executeTodoOp } from "../execute.ts";
import type { TodoParams, TodoPhase } from "../types.ts";

function makeTool(initialPhases: TodoPhase[] = []) {
	let phases = initialPhases;
	return {
		run(params: unknown) {
			const outcome = executeTodoOp(phases, params, { hasSessionFile: false });
			if (!outcome.failed && !outcome.readOnly) phases = outcome.phases;
			return outcome;
		},
		get phases() {
			return phases;
		},
	};
}

function summaryText(
	outcome: ReturnType<ReturnType<typeof makeTool>["run"]>,
): string {
	return outcome.summary;
}

describe("executeTodoOp auto-start behavior", () => {
	it("auto-starts the first task after init", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"in_progress",
			"pending",
		]);
		expect(summaryText(result)).toContain("  Execution:");
		expect(summaryText(result)).toContain("- status (in progress)");
		expect(summaryText(result)).toContain("- diagnostics");
	});

	it("auto-promotes the next pending task when current task is completed", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Execution", items: ["status", "diagnostics"] }],
		});

		const result = tool.run({ op: "done", task: "status" });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"completed",
			"in_progress",
		]);
		expect(result.completedTasks).toEqual([
			{ phase: "Execution", content: "status" },
		]);
		expect(summaryText(result)).toContain('Marked done: "status"');
		expect(summaryText(result)).toContain(
			'Next: "diagnostics" [in_progress] (Execution)',
		);

		const completedResult = tool.run({ op: "done", task: "diagnostics" });
		expect(summaryText(completedResult)).toContain("Next: none.");
	});
});

describe("TodoTool operations", () => {
	it("jumps to a specific task out of order", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Phase A", items: ["first", "second", "third"] }],
		});

		const result = tool.run({ op: "start", task: "third" });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"pending",
			"pending",
			"in_progress",
		]);
		expect(result.op).toBe("start");
	});

	it("demotes the current in_progress task when starting another", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "A", items: ["a1", "a2"] },
				{ phase: "B", items: ["b1"] },
			],
		});

		const result = tool.run({ op: "start", task: "b1" });

		const allTasks = result.phases.flatMap((phase) => phase.tasks);
		expect(allTasks.map((task) => task.status)).toEqual([
			"pending",
			"pending",
			"in_progress",
		]);
	});

	it("appends items to an existing phase", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ op: "append", phase: "Work", items: ["Second"] });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(
			tasks.map((task) => ({ content: task.content, status: task.status })),
		).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("blocks a task (excluded from remaining, counted distinctly) and unblocks it", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const blocked = tool.run({
			op: "block",
			task: "b",
			reason: "waiting on sign-off",
		});
		const bTask = blocked.phases[0]?.tasks.find((task) => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on sign-off");
		expect(summaryText(blocked)).toContain(
			'Blocked "b" (Work): waiting on sign-off.',
		);
		expect(summaryText(blocked)).toContain("1 blocked");

		const unblocked = tool.run({ op: "unblock", task: "b" });
		const bAfter = unblocked.phases[0]?.tasks.find(
			(task) => task.content === "b",
		);
		expect(bAfter?.status).toBe("pending");
		expect(bAfter?.blocker).toBeUndefined();
	});

	it("does not auto-promote a blocked task to in_progress", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["only"] }] });

		const result = tool.run({ op: "block", task: "only" });

		expect(result.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("blocking a phase leaves completed/abandoned tasks closed", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b", "c"] }] });
		tool.run({ op: "done", task: "a" });
		tool.run({ op: "drop", task: "c" });

		const result = tool.run({
			op: "block",
			phase: "Work",
			reason: "waiting on infra",
		});
		const tasks = result.phases[0]?.tasks ?? [];
		const byContent = (content: string) =>
			tasks.find((task) => task.content === content);
		expect(byContent("a")?.status).toBe("completed");
		expect(byContent("c")?.status).toBe("abandoned");
		expect(byContent("b")?.status).toBe("blocked");
		expect(byContent("b")?.blocker).toBe("waiting on infra");
		expect(byContent("a")?.blocker).toBeUndefined();
	});

	it("re-blocking an already-blocked task refines its blocker note", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });
		tool.run({ op: "block", task: "b" });
		const first = tool.run({ op: "block", task: "b" });
		expect(
			first.phases[0]?.tasks.find((task) => task.content === "b")?.blocker,
		).toBeUndefined();

		const refined = tool.run({
			op: "block",
			task: "b",
			reason: "waiting on user",
		});
		const bTask = refined.phases[0]?.tasks.find((task) => task.content === "b");
		expect(bTask?.status).toBe("blocked");
		expect(bTask?.blocker).toBe("waiting on user");
	});

	it("rejects a block with neither task nor phase target", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a", "b"] }] });

		const result = tool.run({ op: "block", reason: "oops" });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain(
			"block requires a task or phase target",
		);
		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.every((task) => task.status !== "blocked")).toBe(true);
	});

	it("rejects an unblock with neither task nor phase target", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a"] }] });
		tool.run({ op: "block", task: "a", reason: "x" });

		const result = tool.run({ op: "unblock" });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain(
			"unblock requires a task or phase target",
		);
		expect(result.phases[0]?.tasks[0]?.status).toBe("blocked");
	});

	it("normalizes a multi-line blocker reason so the summary stays one line", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["a"] }] });
		const blocked = tool.run({
			op: "block",
			task: "a",
			reason: "waiting on user:\nline two\n\tindented three",
		});
		const stored = blocked.phases[0]?.tasks.find(
			(task) => task.content === "a",
		);
		expect(stored?.blocker).toBe("waiting on user: line two indented three");
	});

	it("creates a phase when append targets a missing phase", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({
			op: "append",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.phases.map((phase) => phase.name)).toEqual([
			"Work",
			"Cleanup",
		]);
		expect(result.phases[1]?.tasks.map((task) => task.content)).toEqual([
			"Remove dead code",
		]);
	});

	it("marks all tasks in a phase done", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "Work", items: ["First", "Second"] },
				{ phase: "Later", items: ["Third"] },
			],
		});

		const result = tool.run({ op: "done", phase: "Work" });
		const allTasks = result.phases.flatMap((phase) => phase.tasks);
		expect(allTasks.map((task) => task.status)).toEqual([
			"completed",
			"completed",
			"in_progress",
		]);
	});

	it("a phase done leaves abandoned and blocked tasks alone", () => {
		const tool = makeTool([
			{
				name: "Build",
				tasks: [
					{ content: "queued", status: "pending" },
					{ content: "active", status: "in_progress" },
					{ content: "dropped", status: "abandoned" },
					{ content: "waiting", status: "blocked", blocker: "sign-off" },
				],
			},
			{ name: "Ship", tasks: [{ content: "tag", status: "pending" }] },
		]);

		const result = tool.run({ op: "done", phase: "Build" });

		const statuses = Object.fromEntries(
			result.phases.flatMap((phase) =>
				phase.tasks.map((task) => [task.content, task.status]),
			),
		);
		expect(statuses).toEqual({
			queued: "completed",
			active: "completed",
			dropped: "abandoned",
			waiting: "blocked",
			tag: "in_progress",
		});
		expect(summaryText(result)).toContain('Marked done: "queued", "active"');
		expect(summaryText(result)).toContain(
			'Next: "tag" [in_progress] (Ship)',
		);
	});

	it("a phase done with no open task is a silent no-op", () => {
		const tool = makeTool([
			{
				name: "Closed",
				tasks: [
					{ content: "shipped", status: "completed" },
					{ content: "dropped", status: "abandoned" },
					{ content: "waiting", status: "blocked" },
				],
			},
		]);

		const result = tool.run({ op: "done", phase: "Closed" });

		expect(result.failed).toBe(false);
		expect(result.completedTasks).toEqual([]);
		expect(summaryText(result)).not.toContain("Marked done");
		expect(result.phases[0]?.tasks.map((task) => task.status)).toEqual([
			"completed",
			"abandoned",
			"blocked",
		]);
	});

	it("clears the whole list when rm omits task and phase", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = tool.run({ op: "rm" });
		expect(result.phases).toEqual([]);
		expect(summaryText(result)).toContain("Todo list cleared.");
	});

	it("splices a removed phase out of the list", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "Work", items: ["First"] },
				{ phase: "Later", items: ["Second"] },
			],
		});

		const result = tool.run({ op: "rm", phase: "Work" });
		expect(result.phases.map((phase) => phase.name)).toEqual(["Later"]);
	});

	it("clears the list when the only phase is removed", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ op: "rm", phase: "Work" });
		expect(result.phases).toEqual([]);
		expect(summaryText(result)).toContain("Todo list cleared.");
	});

	it("drops a phase once its last task is removed", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "Work", items: ["First"] },
				{ phase: "Later", items: ["Second"] },
			],
		});

		const result = tool.run({ op: "rm", task: "First" });
		expect(result.phases.map((phase) => phase.name)).toEqual(["Later"]);
	});

	it("clears the list when the last remaining task is removed", () => {
		const tool = makeTool();
		tool.run({ op: "init", items: ["Only"] });

		const result = tool.run({ op: "rm", task: "Only" });
		expect(result.phases).toEqual([]);
		expect(summaryText(result)).toContain("Todo list cleared.");
	});

	it("drops all tasks in a phase", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Work", items: ["First", "Second"] }],
		});

		const result = tool.run({ op: "drop", phase: "Work" });
		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual([
			"abandoned",
			"abandoned",
		]);
	});

	it("view echoes state without mutating it", () => {
		const initial: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "First", status: "pending" },
					{ content: "Second", status: "pending" },
				],
			},
		];
		const tool = makeTool(initial);

		const result = tool.run({ op: "view" });

		const tasks = result.phases[0]?.tasks ?? [];
		expect(tasks.map((task) => task.status)).toEqual(["pending", "pending"]);
		expect(tool.phases[0]?.tasks.map((task) => task.status)).toEqual([
			"pending",
			"pending",
		]);
		expect(summaryText(result)).toContain("First");
		expect(summaryText(result)).toContain("Second");
	});

	it("view on an empty list reports empty, not cleared", () => {
		const tool = makeTool();
		const result = tool.run({ op: "view" });
		expect(summaryText(result)).toContain("Todo list is empty.");
		expect(result.failed).toBe(false);
	});
});

describe("lenient init shapes", () => {
	it("accepts a flattened init with bare items and no phase", () => {
		const tool = makeTool();
		const result = tool.run({ op: "init", items: ["First", "Second"] });

		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Tasks"]);
		const tasks = result.phases[0]?.tasks ?? [];
		expect(
			tasks.map((task) => ({ content: task.content, status: task.status })),
		).toEqual([
			{ content: "First", status: "in_progress" },
			{ content: "Second", status: "pending" },
		]);
	});

	it("honors a bare phase on a flattened init", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "init",
			phase: "Cleanup",
			items: ["Remove dead code"],
		});

		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Cleanup"]);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"Remove dead code",
		]);
	});

	it("still errors when init has neither list nor items", () => {
		const tool = makeTool();
		const result = tool.run({ op: "init" });

		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain("Missing list for init operation");
	});
});

describe("lenient op recovery", () => {
	it("infers init from a bare list payload", () => {
		const tool = makeTool();
		expect(
			inferTodoOp({ list: [{ phase: "Fixes", items: ["One"] }] }, false),
		).toBe("init");
		const result = tool.run({
			list: [
				{
					phase: "Fixes",
					items: ["Bytecompiler ordering", "Posix path fd handling"],
				},
			],
		});

		expect(result.failed).toBe(false);
		expect(result.op).toBe("init");
		expect(result.phases.map((phase) => phase.name)).toEqual(["Fixes"]);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"Bytecompiler ordering",
			"Posix path fd handling",
		]);
	});

	it("infers append from phase plus items", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ phase: "Work", items: ["Second"] });

		expect(result.failed).toBe(false);
		expect(result.op).toBe("append");
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"First",
			"Second",
		]);
	});

	it("infers init from bare items only when no todos exist", () => {
		const fresh = makeTool();
		const initialized = fresh.run({ items: ["Only task"] });
		expect(initialized.failed).toBe(false);
		expect(initialized.op).toBe("init");

		const populated = makeTool([
			{ name: "Work", tasks: [{ content: "First", status: "pending" }] },
		]);
		const ambiguous = populated.run({ items: ["Second"] });
		expect(ambiguous.failed).toBe(true);
	});

	it("surfaces the schema error when op is missing and not inferable", () => {
		const tool = makeTool();
		const result = tool.run({ task: "Something" });

		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain("Invalid todo arguments");
	});
});

describe("empty target safety", () => {
	const initial = [
		{
			name: "Work",
			tasks: [
				{ content: "a", status: "pending" },
				{ content: "b", status: "pending" },
			],
		},
	] as TodoPhase[];

	it.each(["done", "rm", "drop", "block", "unblock"] as const)(
		"empty task with op=%s fails without touching any task",
		(op) => {
			const outcome = executeTodoOp(initial, { op, task: "" }, { hasSessionFile: false });
			expect(outcome.failed).toBe(true);
			expect(outcome.summary).toContain("Missing task content");
			expect(outcome.phases).toEqual(initial);
		},
	);

	it.each(["done", "rm", "drop", "block", "unblock"] as const)(
		"empty phase with op=%s fails without touching any task",
		(op) => {
			const outcome = executeTodoOp(initial, { op, phase: "" }, { hasSessionFile: false });
			expect(outcome.failed).toBe(true);
			expect(outcome.summary).toContain("Missing phase name");
			expect(outcome.phases).toEqual(initial);
		},
	);

	it("omitted targets still mean all tasks (deliberate global op)", () => {
		const outcome = executeTodoOp(initial, { op: "done" }, { hasSessionFile: false });
		expect(outcome.failed).toBe(false);
		expect(outcome.phases[0]?.tasks.every((t) => t.status === "completed")).toBe(true);
	});
});

describe("empty items tolerance", () => {
	it("accepts op:view with an empty items array", () => {
		const tool = makeTool();
		const result = tool.run({ op: "view", items: [] });
		expect(result.failed).toBe(false);
		expect(summaryText(result)).toContain("Todo list is empty.");
	});

	it("defers empty append items to an op-specific runtime error", () => {
		const tool = makeTool();
		tool.run({ op: "init", list: [{ phase: "Work", items: ["First"] }] });

		const result = tool.run({ op: "append", phase: "Work", items: [] });

		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain("Missing items for append operation");
	});
});

describe("getCompletionTransitions", () => {
	it("reports only tasks that transitioned to completed in this update", () => {
		const previous: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "pending" },
					{ content: "b", status: "completed" },
				],
			},
		];
		const updated: TodoPhase[] = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "completed" },
				],
			},
		];
		expect(getCompletionTransitions(previous, updated)).toEqual([
			{ phase: "Work", content: "a" },
		]);
	});
});

describe("normalizeInProgressTask", () => {
	it("keeps only the first in-progress task across phases", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "in_progress" },
					{ content: "a2", status: "in_progress" },
				],
			},
			{ name: "B", tasks: [{ content: "b1", status: "in_progress" }] },
		];
		normalizeInProgressTask(phases);
		expect(phases.flatMap((p) => p.tasks).map((t) => t.status)).toEqual([
			"in_progress",
			"pending",
			"pending",
		]);
	});

	it("promotes the first pending task when nothing is in progress", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a1", status: "pending" },
					{ content: "a2", status: "pending" },
				],
			},
		];
		normalizeInProgressTask(phases);
		expect(phases[0]?.tasks.map((t) => t.status)).toEqual([
			"in_progress",
			"pending",
		]);
	});
});

describe("single-line normalization of task content and phase names", () => {
	it("collapses newlines and tabs in init items and phase names", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "init",
			list: [
				{
					phase: "  Recon\nphase  ",
					items: ["line1\nline2", "tabbed\ttask", "  padded  "],
				},
			],
		});

		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Recon phase"]);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"line1 line2",
			"tabbed task",
			"padded",
		]);
	});

	it("rejects whitespace-only items and phase names in init", () => {
		const tool = makeTool();
		const blankItem = tool.run({ op: "init", items: ["ok", "  \n "] });
		expect(blankItem.failed).toBe(true);
		expect(summaryText(blankItem)).toContain("Empty task content");

		const blankPhase = tool.run({
			op: "init",
			list: [{ phase: " \t ", items: ["ok"] }],
		});
		expect(blankPhase.failed).toBe(true);
		expect(summaryText(blankPhase)).toContain("Empty phase name");
	});

	it("detects duplicates after normalization", () => {
		const tool = makeTool();
		const result = tool.run({ op: "init", items: ["a  b", "a\nb"] });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain('Duplicate task "a b"');
	});

	it("normalizes append phase names and items", () => {
		const tool = makeTool();
		const init = tool.run({ op: "init", items: ["one"] });
		expect(init.failed).toBe(false);
		const result = tool.run({
			op: "append",
			phase: "later\nphase",
			items: ["two\nlines"],
		});

		expect(result.failed).toBe(false);
		expect(
			result.phases.map((phase) => [
				phase.name,
				phase.tasks.map((task) => task.content),
			]),
		).toEqual([
			["Tasks", ["one"]],
			["later phase", ["two lines"]],
		]);
	});

	it("rejects whitespace-only phase and items on append", () => {
		const tool = makeTool([{ name: "A", tasks: [] }]);
		const blankPhase = tool.run({ op: "append", phase: "  ", items: ["x"] });
		expect(blankPhase.failed).toBe(true);
		expect(summaryText(blankPhase)).toContain(
			"Missing phase name for append operation",
		);

		const blankItem = tool.run({ op: "append", phase: "A", items: ["\t"] });
		expect(blankItem.failed).toBe(true);
		expect(summaryText(blankItem)).toContain("Empty task content");
	});
});

describe("summary modes", () => {
	function plan() {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "Build", items: ["Write the parser", "Add fixtures"] },
				{ phase: "Ship", items: ["Tag release"] },
			],
		});
		return tool;
	}

	it("done returns a delta: change, next, overall, active phase", () => {
		const tool = plan();
		const result = tool.run({ op: "done", task: "Write the parser" });
		expect(summaryText(result)).toBe(
			[
				'Marked done: "Write the parser"',
				'Next: "Add fixtures" [in_progress] (Build)',
				"Overall: 1/3 done, 2 open.",
				'Active phase 1/2 "Build" (1/2).',
			].join("\n"),
		);
	});

	it("start returns a delta", () => {
		const tool = plan();
		const result = tool.run({ op: "start", task: "Tag release" });
		expect(summaryText(result)).toContain('Started: "Tag release"');
		expect(summaryText(result)).toContain(
			'Next: "Write the parser" [pending] (Build)',
		);
	});

	it("drop returns a delta", () => {
		const tool = plan();
		const result = tool.run({ op: "drop", task: "Add fixtures" });
		expect(summaryText(result)).toContain('Dropped: "Add fixtures"');
		expect(summaryText(result)).toContain("Overall: 1/3 done, 2 open.");
	});

	it("block returns a delta with the phase and the reason", () => {
		const tool = plan();
		const result = tool.run({
			op: "block",
			task: "Tag release",
			reason: "waiting on sign-off",
		});
		expect(summaryText(result)).toContain(
			'Blocked "Tag release" (Ship): waiting on sign-off.',
		);
		expect(summaryText(result)).toContain("Overall: 0/3 done, 2 open, 1 blocked.");
	});

	it("unblock returns a delta", () => {
		const tool = plan();
		tool.run({ op: "block", task: "Tag release", reason: "x" });
		const result = tool.run({ op: "unblock", task: "Tag release" });
		expect(summaryText(result)).toContain('Unblocked: "Tag release"');
	});

	it("init, append, rm and view return the full list", () => {
		const tool = plan();
		expect(summaryText(tool.run({ op: "view" }))).toContain("  Build:");
		expect(
			summaryText(tool.run({ op: "append", phase: "Ship", items: ["Cut tag"] })),
		).toContain("  Ship:");
		expect(summaryText(tool.run({ op: "rm", task: "Cut tag" }))).toContain(
			"  Ship:",
		);
		expect(
			summaryText(tool.run({ op: "init", items: ["Only task"] })),
		).toContain("  Tasks:");
	});

	it("a failed call returns the full list with the error first", () => {
		const tool = plan();
		const result = tool.run({ op: "done", task: "nope" });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain('Errors: Task "nope" not found');
		expect(summaryText(result)).toContain("  Build:");
		expect(summaryText(result)).toContain("Overall: 0/3 done, 3 open.");
	});

	it("caps change names at six", () => {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{
					phase: "Bulk",
					items: ["1", "2", "3", "4", "5", "6", "7", "8"],
				},
			],
		});
		const result = tool.run({ op: "drop" });
		expect(summaryText(result)).toContain(
			'Dropped: "1", "2", "3", "4", "5", "6" (+2 more)',
		);
	});

	it("prints no Remaining items block in either mode", () => {
		const tool = plan();
		expect(summaryText(tool.run({ op: "view" }))).not.toContain(
			"Remaining items",
		);
		expect(
			summaryText(tool.run({ op: "done", task: "Write the parser" })),
		).not.toContain("Remaining items");
	});
});

describe("collapsed full list", () => {
	function closedPlan() {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [{ phase: "Work", items: ["kept", "finished", "removed", "next"] }],
		});
		tool.run({ op: "done", task: "finished" });
		tool.run({ op: "drop", task: "removed" });
		return tool;
	}

	it("prints open tasks and one closed-count line per phase", () => {
		const summary = summaryText(closedPlan().run({ op: "view" }));
		expect(summary).toContain("  Work:");
		expect(summary).toContain("- kept");
		expect(summary).toContain("- next");
		expect(summary).toContain("    (1 done, 1 dropped)");
	});

	it("omits closed task text from the full list", () => {
		const summary = summaryText(closedPlan().run({ op: "view" }));
		expect(summary).not.toContain("finished");
		expect(summary).not.toContain("removed");
	});

	it("omits the count line when nothing is closed", () => {
		const tool = makeTool();
		const summary = summaryText(tool.run({ op: "init", items: ["only"] }));
		expect(summary).toContain("- only");
		expect(summary).not.toMatch(/\(\d+ done/);
	});

	it("reports a single closed kind without a zero count", () => {
		const tool = makeTool();
		tool.run({ op: "init", items: ["a", "b"] });
		tool.run({ op: "done", task: "b" });
		const summary = summaryText(tool.run({ op: "view" }));
		expect(summary).toContain("    (1 done)");
		expect(summary).not.toContain("dropped");
	});
});

describe("update op", () => {
	function plan() {
		const tool = makeTool();
		tool.run({
			op: "init",
			list: [
				{ phase: "Build", items: ["parser", "fixtures", "report"] },
				{ phase: "Ship", items: ["tag"] },
			],
		});
		return tool;
	}

	it("renames a task and keeps its status", () => {
		const tool = plan();
		const result = tool.run({
			op: "update",
			task: "parser",
			content: "lalr parser",
		});
		expect(result.failed).toBe(false);
		const renamed = result.phases[0]?.tasks.find(
			(task) => task.content === "lalr parser",
		);
		expect(renamed?.status).toBe("in_progress");
		expect(summaryText(result)).toContain('Renamed "parser" to "lalr parser".');
	});

	it("keeps a renamed task's position in its phase", () => {
		const tool = plan();
		tool.run({ op: "update", task: "report", content: "release notes" });
		expect(tool.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"parser",
			"fixtures",
			"release notes",
		]);
	});

	it("rejects a rename onto an existing task", () => {
		const tool = plan();
		const result = tool.run({
			op: "update",
			task: "parser",
			content: "fixtures",
		});
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain('Task "fixtures" already exists');
	});

	it("moves a task to an existing phase at the end", () => {
		const tool = plan();
		const result = tool.run({ op: "update", task: "report", phase: "Ship" });
		expect(
			result.phases.map((phase) => [
				phase.name,
				phase.tasks.map((task) => task.content),
			]),
		).toEqual([
			["Build", ["parser", "fixtures"]],
			["Ship", ["tag", "report"]],
		]);
		expect(summaryText(result)).toContain('Moved "report" to "Ship".');
	});

	it("moves a task before another in the destination phase", () => {
		const tool = plan();
		const result = tool.run({
			op: "update",
			task: "report",
			phase: "Ship",
			before: "tag",
		});
		expect(result.phases[1]?.tasks.map((task) => task.content)).toEqual([
			"report",
			"tag",
		]);
	});

	it("creates the destination phase when it is missing", () => {
		const tool = plan();
		const result = tool.run({ op: "update", task: "tag", phase: "Release" });
		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual([
			"Build",
			"Release",
		]);
		expect(result.phases[1]?.tasks.map((task) => task.content)).toEqual(["tag"]);
	});

	it("reorders within a phase when given only before", () => {
		const tool = plan();
		const result = tool.run({ op: "update", task: "report", before: "parser" });
		expect(result.failed).toBe(false);
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"report",
			"parser",
			"fixtures",
		]);
		expect(summaryText(result)).toContain(
			'Reordered "report" before "parser".',
		);
	});

	it("requires content, phase, or before", () => {
		const tool = plan();
		const result = tool.run({ op: "update", task: "parser" });
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain(
			"update requires content, phase, or before",
		);
	});

	it("rejects a before target outside the destination phase", () => {
		const tool = plan();
		const result = tool.run({
			op: "update",
			task: "tag",
			phase: "Ship",
			before: "parser",
		});
		expect(result.failed).toBe(true);
		expect(summaryText(result)).toContain(
			'Task "parser" not found in phase "Ship"',
		);
	});

	it("targets the renamed content afterwards", () => {
		const tool = plan();
		tool.run({ op: "update", task: "parser", content: "lalr parser" });
		const result = tool.run({ op: "done", task: "lalr parser" });
		expect(result.failed).toBe(false);
		expect(result.completedTasks).toEqual([
			{ phase: "Build", content: "lalr parser" },
		]);
	});
});

describe("normalizeTodoArgs", () => {
	it("moves a list of strings to items", () => {
		expect(normalizeTodoArgs({ op: "init", list: ["a", "b"] })).toEqual({
			op: "init",
			items: ["a", "b"],
		});
	});

	it("converts a phase map to a phased list", () => {
		expect(normalizeTodoArgs({ list: { Build: ["a"], Ship: ["b"] } })).toEqual({
			list: [
				{ phase: "Build", items: ["a"] },
				{ phase: "Ship", items: ["b"] },
			],
		});
	});

	it("takes a list entry's phase from its name", () => {
		expect(
			normalizeTodoArgs({ list: [{ name: "Build", items: ["a"] }] }),
		).toEqual({ list: [{ name: "Build", phase: "Build", items: ["a"] }] });
	});

	it("wraps a string of items in an array", () => {
		expect(
			normalizeTodoArgs({ list: [{ phase: "Build", items: "a" }] }),
		).toEqual({ list: [{ phase: "Build", items: ["a"] }] });
	});

	it("drops a list entry with no items", () => {
		expect(
			normalizeTodoArgs({
				list: [
					{ phase: "Build", items: [] },
					{ phase: "Ship", items: ["b"] },
				],
			}),
		).toEqual({ list: [{ phase: "Ship", items: ["b"] }] });
	});

	it("deletes an unknown op so inference runs", () => {
		expect(normalizeTodoArgs({ op: "complete", task: "a" })).toEqual({
			task: "a",
		});
		expect(normalizeTodoArgs({ op: "done", task: "a" })).toEqual({
			op: "done",
			task: "a",
		});
	});
});

describe("argument shape recovery at execute time", () => {
	it("infers init from a bare list of strings", () => {
		const tool = makeTool();
		const result = tool.run({ list: ["First", "Second"] });
		expect(result.failed).toBe(false);
		expect(result.op).toBe("init");
		expect(result.phases[0]?.tasks.map((task) => task.content)).toEqual([
			"First",
			"Second",
		]);
	});

	it("infers init from a phase map", () => {
		const tool = makeTool();
		const result = tool.run({ list: { Work: ["First"] } });
		expect(result.failed).toBe(false);
		expect(result.phases.map((phase) => phase.name)).toEqual(["Work"]);
	});

	it("recovers from an unknown op name", () => {
		const tool = makeTool();
		const result = tool.run({
			op: "complete",
			list: [{ phase: "Work", items: ["First"] }],
		});
		expect(result.failed).toBe(false);
		expect(result.op).toBe("init");
	});
});
