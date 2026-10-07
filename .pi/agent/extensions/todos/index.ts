/**
 * todos — an Oh My Pi (OMP)-style todo tool and tracker for pi.
 *
 * Replicates the OMP todo experience as a pi extension package:
 *
 * - **`todo` tool** (`init|start|done|rm|drop|block|unblock|append|view`)
 *   with phased lists, auto-promotion of the next task, completion
 *   transitions, and strict batch semantics. Persistence is the tool result
 *   itself: every successful result carries `details.phases`, and state is
 *   reconstructed by scanning the session branch (the same durable-record
 *   pattern OMP and pi's example extensions use — branching/rewinding always
 *   shows the correct todo state).
 * - **Eager prelude** (`todo.eager: "preferred" | "always"`): on the first
 *   turn, a hidden reminder asks the model to lay out a phased plan with a
 *   single `init` call before working. pi's extension API cannot force a
 *   `tool_choice`, so `"always"` injects a MUST-call reminder instead.
 * - **Bundled `todo-discipline` skill**: contributed via `resources_discover`
 *   whenever the tool is enabled, so every model gets a load-on-demand skill
 *   that mandates phased `init` before work and per-task `done` marking as
 *   each task finishes (not retro-batched at the end).
 * - **Mid-run nudge**: after 12 mutating tool results, a hidden steer
 *   message asks the agent to mark finished tasks done (≤2 per prompt
 *   cycle).
 * - **Completion reminder**: when the agent settles with incomplete todos
 *   and isn't waiting on the user, a reminder is injected and a fresh turn
 *   is triggered (`todo.reminders`, `todo.remindersMax`).
 *
 * Config lives in `<agent dir>/todo.json` (global) and `<cwd>/.pi/todo.json`
 * (project, trusted only): `enabled`, `reminders`, `remindersMax`, `eager`.
 * CLI flags take precedence over environment variables and JSON config.
 *
 * @module todos
 */

import { fileURLToPath } from "node:url";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	resolveTodoConfig,
	TODO_CONFIG_DEFAULTS,
	TODO_FLAGS,
	type TodoConfig,
} from "./config.ts";
import { executeTodoOp } from "./execute.ts";
import {
	TODO_REMINDER_CUSTOM_TYPE,
	TodoTracker,
	pruneSupersededTrackerMessages,
} from "./tracker.ts";
import { clonePhases, inferTodoOp } from "./state.ts";
import { TODO_TOOL_DESCRIPTION } from "./prompts.ts";
import {
	todoSchema,
	type TodoParams,
	type TodoPhase,
	type TodoToolDetails,
} from "./types.ts";

/** Bundled skill directory shipped with the package (skills/todo-discipline). */
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("./skills", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function todosExtension(pi: ExtensionAPI): void {
	pi.registerFlag(TODO_FLAGS.enabled, {
		type: "string",
		description:
			"Enable or disable the todos tool (on|off). Overrides PI_TODO_ENABLED and todo.json.",
	});
	pi.registerFlag(TODO_FLAGS.reminders, {
		type: "string",
		description:
			"Enable or disable incomplete-todo reminders (on|off). Overrides PI_TODO_REMINDERS and todo.json.",
	});
	pi.registerFlag(TODO_FLAGS.remindersMax, {
		type: "string",
		description:
			"Maximum incomplete-todo reminders per cycle. Overrides PI_TODO_REMINDERS_MAX and todo.json.",
	});
	pi.registerFlag(TODO_FLAGS.eager, {
		type: "string",
		description:
			"Todo eager mode (default|preferred|always). Overrides PI_TODO_EAGER and todo.json.",
	});

	let phases: TodoPhase[] = [];
	let config: TodoConfig = TODO_CONFIG_DEFAULTS;
	let lastAssistant: AssistantMessage | undefined;

	function getPhases(): TodoPhase[] {
		return clonePhases(phases);
	}

	function setPhases(next: TodoPhase[]): void {
		phases = clonePhases(next);
	}

	const tracker = new TodoTracker({
		config: () => config,
		getPhases,
		setPhases: (next: TodoPhase[]) => setPhases(next),
		getBranch: (ctx) => ctx.sessionManager.getBranch(),
		hasPendingMessages: (ctx) => ctx.hasPendingMessages(),
		getActiveToolNames: () => pi.getActiveTools(),
		sendReminder: async (_ctx, reminderText) => {
			pi.sendMessage(
				{
					customType: TODO_REMINDER_CUSTOM_TYPE,
					content: reminderText,
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});

	const todoTool = defineTool({
		name: "todo",
		label: "Todo",
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet:
			"Write a structured todo list to track progress within a session",
		promptGuidelines: [
			"Use the todo tool to track multi-step work as a phased list; update it as the work progresses.",
			"When the user provides a multi-step plan or enumerates N items/bugs/tasks, initialize every item as its own todo task before working.",
			"Mark tasks done immediately after finishing them; batch todo calls with real work instead of making solo todo turns.",
		],
		parameters: todoSchema,
		executionMode: "sequential",

		// Repairs a missing `op` (models routinely send `{list:[...]}` with no
		// op) before schema validation, mirroring omp's `lenientArgValidation`
		// + `resolveTodoParams` behavior. Uninferable shapes return as-is and
		// fail schema validation for a normal model retry.
		prepareArguments(args: unknown): TodoParams {
			if (isRecord(args) && args.op === undefined) {
				const inferred = inferTodoOp(args, phases.length > 0);
				if (inferred) return { ...args, op: inferred } as TodoParams;
			}
			return args as TodoParams;
		},

		async execute(
			_toolCallId: string,
			params: TodoParams,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<TodoToolDetails> | undefined,
			ctx: ExtensionToolContext,
		): Promise<AgentToolResult<TodoToolDetails>> {
			const previousPhases = getPhases();
			const outcome = executeTodoOp(
				previousPhases,
				params,
				Boolean(ctx.sessionManager.getSessionFile()),
			);
			// pi signals tool errors by throwing; the model receives the message
			// text (omp's formatSummary output, errors + full current list).
			if (outcome.failed) throw new Error(outcome.summary);
			if (!outcome.readOnly) setPhases(outcome.phases);
			const details: TodoToolDetails = {
				op: outcome.op,
				phases: outcome.phases,
				storage: outcome.storage,
			};
			if (outcome.completedTasks.length > 0)
				details.completedTasks = outcome.completedTasks;

			return {
				content: [{ type: "text", text: outcome.summary }],
				details,
			};
		},
	});

	pi.registerTool(todoTool);

	// session_start runs before resources_discover (pi emits them back-to-back
	// at startup and on /reload), so `config` is already resolved here.
	pi.on("resources_discover", async (_event, _ctx) => {
		if (!config.enabled) return undefined;
		return { skillPaths: [BUNDLED_SKILLS_DIR] };
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = resolveTodoConfig(
			ctx.cwd,
			() => ctx.isProjectTrusted(),
			(message) => {
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else console.error(message);
			},
			(name) => pi.getFlag(name),
		);
		config = loaded.config;
		if (!config.enabled) {
			const active = pi.getActiveTools();
			if (active.includes("todo")) {
				pi.setActiveTools(active.filter((name) => name !== "todo"));
			}
		}
		tracker.syncFromBranch(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		tracker.syncFromBranch(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		tracker.syncFromBranch(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		tracker.resetCycle();
		const prelude = tracker.createEagerTodoPrelude(event.prompt, ctx);
		return prelude ? { message: prelude } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		tracker.onToolResult(event.toolName, event.isError);
		const nudge = tracker.takeMidRunNudge(ctx);
		if (nudge) {
			pi.sendMessage(nudge, { deliverAs: "steer" });
		}
	});

	// Tracker-injected guidance (completion reminders, mid-run nudges) is
	// only valid for the turn that consumes it; before every LLM call strip
	// any such message a later real message superseded, so resumed/continued
	// sessions never make the model answer an ancient "incomplete todos"
	// reminder (it lives on in the session file; only the outgoing copy is
	// filtered).
	pi.on("context", async (event) => {
		const pruned = pruneSupersededTrackerMessages(event.messages);
		if (pruned.length === event.messages.length) return undefined;
		return { messages: pruned as typeof event.messages };
	});

	pi.on("agent_end", async (event) => {
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message !== undefined && message.role === "assistant") {
				lastAssistant = message as AssistantMessage;
				break;
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await tracker.checkCompletion(ctx, lastAssistant);
	});
}
