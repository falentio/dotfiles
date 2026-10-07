/**
 * TodoTracker behavior: eager prelude, mid-run nudges, completion reminders,
 * and the awaiting-user heuristic. Ported from omp's todo-tracker semantics.
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { TODO_CONFIG_DEFAULTS, type TodoConfig } from "../config.ts";
import {
	EAGER_TODO_PRELUDE_CUSTOM_TYPE,
	isAwaitingUserAnswer,
	MID_RUN_NUDGE_MESSAGE_TYPE,
	pruneSupersededTrackerMessages,
	TodoTracker,
	TODO_REMINDER_CUSTOM_TYPE,
} from "../tracker.ts";
import type { TodoPhase } from "../types.ts";

function makeContext(
	entries: SessionEntry[] = [],
	pending = false,
): ExtensionContext {
	return {
		sessionManager: { getBranch: () => entries },
		hasPendingMessages: () => pending,
	} as unknown as ExtensionContext;
}

function makeTracker(overrides: {
	config?: Partial<TodoConfig>;
	phases?: TodoPhase[];
	entries?: SessionEntry[];
	activeTools?: string[];
	pending?: boolean;
}) {
	// Mirrors the production wiring: the host owns the single canonical copy
	// and the tracker reads/writes it through the host interface.
	let phases: TodoPhase[] = [];
	const host = {
		config: () => ({ ...TODO_CONFIG_DEFAULTS, ...overrides.config }),
		getPhases: () => phases,
		setPhases: (next: TodoPhase[]) => {
			phases = next;
		},
		getBranch: (ctx: ExtensionContext) => ctx.sessionManager.getBranch(),
		hasPendingMessages: (ctx: ExtensionContext) => ctx.hasPendingMessages(),
		getActiveToolNames: () => overrides.activeTools ?? ["todo", "bash"],
	};
	const tracker = new TodoTracker(host);
	if (overrides.phases) tracker.setPhases(overrides.phases);
	return {
		tracker,
		setHostPhases: (next: TodoPhase[]) => {
			phases = next;
		},
	};
}

function assistantMessage(
	text: string,
	stopReason = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text } satisfies TextContent],
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

describe("createEagerTodoPrelude", () => {
	it("returns nothing on the default eager mode", () => {
		const { tracker } = makeTracker({});
		expect(
			tracker.createEagerTodoPrelude("Do the thing", makeContext()),
		).toBeUndefined();
	});

	it("injects a preferred reminder when eager=preferred and no todos exist", () => {
		const { tracker } = makeTracker({ config: { eager: "preferred" } });
		const prelude = tracker.createEagerTodoPrelude(
			"Build the feature",
			makeContext(),
		);
		expect(prelude?.customType).toBe(EAGER_TODO_PRELUDE_CUSTOM_TYPE);
		expect(prelude?.display).toBe(false);
		expect(prelude?.content).toContain("Consider calling `todo` first");
		expect(prelude?.content).not.toContain("MUST");
	});

	it("injects a MUST-call reminder when eager=always", () => {
		const { tracker } = makeTracker({ config: { eager: "always" } });
		const prelude = tracker.createEagerTodoPrelude(
			"Build the feature",
			makeContext(),
		);
		expect(prelude?.content).toContain("MUST call `todo` first");
	});

	it("skips when todos already exist", () => {
		const { tracker } = makeTracker({
			config: { eager: "always" },
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		expect(
			tracker.createEagerTodoPrelude("Continue", makeContext()),
		).toBeUndefined();
	});

	it("skips when disabled", () => {
		const { tracker } = makeTracker({
			config: { enabled: false, eager: "always" },
		});
		expect(
			tracker.createEagerTodoPrelude("Build", makeContext()),
		).toBeUndefined();
	});

	it("skips when the prompt is a question or exclamation", () => {
		const { tracker } = makeTracker({ config: { eager: "always" } });
		expect(
			tracker.createEagerTodoPrelude("Can you review this?", makeContext()),
		).toBeUndefined();
		expect(
			tracker.createEagerTodoPrelude("Wow!", makeContext()),
		).toBeUndefined();
	});

	it("skips when prior user messages exist (not the first turn)", () => {
		const { tracker } = makeTracker({ config: { eager: "always" } });
		const ctx = makeContext([
			{ type: "message", message: { role: "user" } },
		] as unknown as SessionEntry[]);
		expect(tracker.createEagerTodoPrelude("Continue", ctx)).toBeUndefined();
	});

	it("skips when the todo tool is not active", () => {
		const { tracker } = makeTracker({
			config: { eager: "always" },
			activeTools: ["bash"],
		});
		expect(
			tracker.createEagerTodoPrelude("Build", makeContext()),
		).toBeUndefined();
	});
});

describe("takeMidRunNudge", () => {
	it("returns nothing below the mutation threshold", () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 11; i++) tracker.onToolResult("edit", false);
		expect(tracker.takeMidRunNudge(makeContext())).toBeNull();
	});

	it("fires after 12 mutating tool results and counts toward the cycle budget", () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 12; i++) tracker.onToolResult("edit", false);
		const nudge = tracker.takeMidRunNudge(makeContext());
		expect(nudge?.customType).toBe(MID_RUN_NUDGE_MESSAGE_TYPE);
		expect(nudge?.content).toContain("1 todo item still open");
		// Budget: a second nudge needs another 12 mutations.
		expect(tracker.takeMidRunNudge(makeContext())).toBeNull();
		for (let i = 0; i < 12; i++) tracker.onToolResult("write", false);
		expect(tracker.takeMidRunNudge(makeContext())).not.toBeNull();
	});

	it("caps at 2 nudges per cycle", () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 36; i++) tracker.onToolResult("edit", false);
		expect(tracker.takeMidRunNudge(makeContext())).not.toBeNull();
		expect(tracker.takeMidRunNudge(makeContext())).toBeNull();
		tracker.resetCycle();
		expect(tracker.takeMidRunNudge(makeContext())).toBeNull();
	});

	it("does not fire without incomplete todos, when disabled, or without the tool", () => {
		const none = makeTracker({});
		for (let i = 0; i < 12; i++) none.tracker.onToolResult("edit", false);
		expect(none.tracker.takeMidRunNudge(makeContext())).toBeNull();

		const disabled = makeTracker({
			config: { enabled: false },
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 12; i++) disabled.tracker.onToolResult("edit", false);
		expect(disabled.tracker.takeMidRunNudge(makeContext())).toBeNull();

		const noTool = makeTracker({
			activeTools: ["bash"],
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 12; i++) noTool.tracker.onToolResult("edit", false);
		expect(noTool.tracker.takeMidRunNudge(makeContext())).toBeNull();
	});

	it("todo results reset the mutation counter", () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 12; i++) tracker.onToolResult("edit", false);
		tracker.onToolResult("todo", false);
		expect(tracker.takeMidRunNudge(makeContext())).toBeNull();
	});

	it("counts only successful mutating tools", () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 12; i++) tracker.onToolResult("edit", true);
		expect(tracker.takeMidRunNudge(makeContext())).toBeNull();
	});

	it("counts codemode mutations (pi's name for omp's eval)", () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		for (let i = 0; i < 12; i++) tracker.onToolResult("codemode", false);
		expect(tracker.takeMidRunNudge(makeContext())).not.toBeNull();
	});
});

describe("checkCompletion", () => {
	it("returns null when all todos are complete", async () => {
		const { tracker } = makeTracker({
			phases: [
				{ name: "Work", tasks: [{ content: "a", status: "completed" }] },
			],
		});
		const reminder = await tracker.checkCompletion(
			makeContext(),
			assistantMessage("All done."),
		);
		expect(reminder).toBeNull();
	});

	it("returns the reminder with the incomplete list and re-arms the budget", async () => {
		const { tracker } = makeTracker({
			phases: [
				{
					name: "Work",
					tasks: [
						{ content: "a", status: "in_progress" },
						{ content: "b", status: "pending" },
						{ content: "c", status: "blocked" },
					],
				},
			],
		});
		const reminder = await tracker.checkCompletion(
			makeContext(),
			assistantMessage("I stopped here."),
		);
		expect(reminder).toContain("2 incomplete todo item(s)");
		expect(reminder).toContain("- Work");
		expect(reminder).toContain("  - a");
		expect(reminder).toContain("  - b");
		// blocked tasks are excluded from the reminder list
		expect(reminder).not.toContain("  - c");
		expect(reminder).toContain("(Reminder 1/3)");
	});

	it("stays silent after a reminder until progress is made", async () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Stopped."),
			),
		).not.toBeNull();
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Stopped again."),
			),
		).toBeNull();
		// Progress (any tool result) re-arms the reminder.
		tracker.onToolResult("edit", false);
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Stopped again."),
			),
		).not.toBeNull();
	});

	it("respects remindersMax", async () => {
		const { tracker } = makeTracker({
			config: { remindersMax: 2 },
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		expect(
			await tracker.checkCompletion(makeContext(), assistantMessage("Stop 1.")),
		).not.toBeNull();
		tracker.onToolResult("edit", false);
		expect(
			await tracker.checkCompletion(makeContext(), assistantMessage("Stop 2.")),
		).not.toBeNull();
		tracker.onToolResult("edit", false);
		expect(
			await tracker.checkCompletion(makeContext(), assistantMessage("Stop 3.")),
		).toBeNull();
	});

	it("returns null when the assistant is awaiting user input", async () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		const reminder = await tracker.checkCompletion(
			makeContext(),
			assistantMessage("Should I continue with the current approach?"),
		);
		expect(reminder).toBeNull();
	});

	it("returns null while messages are pending (loop will re-enter anyway)", async () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		const reminder = await tracker.checkCompletion(
			makeContext([], true),
			assistantMessage("Stopped."),
		);
		expect(reminder).toBeNull();
	});

	it("reads live host state, so reminders track external mutations", async () => {
		// The tracker must not keep its own snapshot: completing a task outside
		// the tracker (the todo tool writes the host copy) silences the
		// reminder, and creating a task arms it.
		const { tracker, setHostPhases } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		setHostPhases([
			{ name: "Work", tasks: [{ content: "a", status: "completed" }] },
		]);
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Finished."),
			),
		).toBeNull();
		setHostPhases([
			{
				name: "Work",
				tasks: [{ content: "brand new", status: "in_progress" }],
			},
		]);
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Stopped."),
			),
		).toContain("brand new");
	});

	it("returns null when the todo tool is not active", async () => {
		const { tracker } = makeTracker({
			activeTools: ["bash"],
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		const reminder = await tracker.checkCompletion(
			makeContext(),
			assistantMessage("Stopped."),
		);
		expect(reminder).toBeNull();
	});

	it("returns null after aborted or errored runs", async () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Interrupted.", "aborted"),
			),
		).toBeNull();
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("API blew up.", "error"),
			),
		).toBeNull();
		// A clean stop still reminds.
		expect(
			await tracker.checkCompletion(
				makeContext(),
				assistantMessage("Stopped normally."),
			),
		).not.toBeNull();
	});

	it("resets the budget when reminders are disabled or the list is empty", async () => {
		const { tracker } = makeTracker({
			config: { reminders: false },
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		expect(
			await tracker.checkCompletion(makeContext(), assistantMessage("Stop.")),
		).toBeNull();

		const empty = makeTracker({ config: { remindersMax: 1 } });
		expect(
			await empty.tracker.checkCompletion(
				makeContext(),
				assistantMessage("Stop."),
			),
		).toBeNull();
	});

	it("returns the reminder text the boundary handler injects", async () => {
		const { tracker } = makeTracker({
			phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }] }],
		});
		const reminder = await tracker.checkCompletion(
			makeContext(),
			assistantMessage("Done for now."),
		);
		expect(reminder).toContain("incomplete todo item(s)");
	});
});

describe("pruneSupersededTrackerMessages", () => {
	const reminder = {
		role: "custom",
		customType: TODO_REMINDER_CUSTOM_TYPE,
		content: "You stopped with 1 incomplete todo item(s)",
		display: false,
	};
	const nudge = {
		role: "custom",
		customType: MID_RUN_NUDGE_MESSAGE_TYPE,
		content: "1 todo item still open",
		display: false,
	};
	const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
	const user = { role: "user", content: [{ type: "text", text: "next" }] };

	it("keeps a trailing reminder that triggered the current turn", () => {
		expect(pruneSupersededTrackerMessages([user, reminder])).toEqual([
			user,
			reminder,
		]);
	});

	it("drops reminders and nudges any later real message superseded", () => {
		expect(
			pruneSupersededTrackerMessages([reminder, assistant, user]),
		).toEqual([assistant, user]);
		expect(
			pruneSupersededTrackerMessages([nudge, assistant, reminder]),
		).toEqual([assistant, reminder]);
	});

	it("leaves non-tracker custom messages and plain histories untouched", () => {
		const other = { role: "custom", customType: "other", content: "x", display: false };
		expect(pruneSupersededTrackerMessages([user, other, assistant])).toEqual([
			user,
			other,
			assistant,
		]);
		expect(pruneSupersededTrackerMessages([])).toEqual([]);
		expect(pruneSupersededTrackerMessages([reminder, nudge])).toEqual([
			reminder,
			nudge,
		]);
	});
});

describe("isAwaitingUserAnswer", () => {
	it("detects a trailing question", () => {
		expect(
			isAwaitingUserAnswer(assistantMessage("Which option do you prefer?")),
		).toBe(true);
		expect(isAwaitingUserAnswer(assistantMessage("The fix is in place."))).toBe(
			false,
		);
	});

	it("detects response cues (please let me know / answer)", () => {
		expect(
			isAwaitingUserAnswer(
				assistantMessage("Please let me know how to proceed."),
			),
		).toBe(true);
		expect(isAwaitingUserAnswer(assistantMessage("Answer yes or no."))).toBe(
			true,
		);
	});

	it("only inspects the last line", () => {
		expect(
			isAwaitingUserAnswer(
				assistantMessage("First question?\nThen I'll wait for your reply."),
			),
		).toBe(false);
		expect(
			isAwaitingUserAnswer(
				assistantMessage(
					"Let me check the code.\nWhich approach should I take?",
				),
			),
		).toBe(true);
	});

	it("strips markdown decoration around trailing questions", () => {
		expect(
			isAwaitingUserAnswer(assistantMessage("**Should I continue?**")),
		).toBe(true);
		expect(
			isAwaitingUserAnswer(assistantMessage("_What do you think?_")),
		).toBe(true);
		expect(
			isAwaitingUserAnswer(
				assistantMessage("The fix is in place. **Choose one.**"),
			),
		).toBe(false);
	});

	it("ignores non-text content", () => {
		expect(
			isAwaitingUserAnswer({
				role: "assistant",
				content: [],
				timestamp: 0,
			} as unknown as AssistantMessage),
		).toBe(false);
	});
});

describe("syncFromBranch", () => {
	it("rehydrates phases from the branch", () => {
		const entries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						phases: [
							{ name: "W", tasks: [{ content: "a", status: "pending" }] },
						],
					},
				},
			},
		] as unknown as SessionEntry[];
		const { tracker } = makeTracker({});
		tracker.syncFromBranch(makeContext(entries));
		expect(tracker.phases).toEqual([
			{ name: "W", tasks: [{ content: "a", status: "pending" }] },
		]);
	});
});
