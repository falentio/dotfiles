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
import { TODO_CONFIG } from "./config.ts";
import { executeTodoOp } from "./execute.ts";
import {
	TODO_REMINDER_CUSTOM_TYPE,
	TodoTracker,
	pruneSupersededTrackerMessages,
} from "./tracker.ts";
import { TODO_SNAPSHOT_CUSTOM_TYPE } from "./persistence.ts";
import { clonePhases, inferTodoOp } from "./state.ts";
import { TODO_TOOL_DESCRIPTION } from "./prompts.ts";
import {
	todoSchema,
	type TodoParams,
	type TodoPhase,
	type TodoToolDetails,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function todosExtension(pi: ExtensionAPI): void {
	let phases: TodoPhase[] = [];
	let lastAssistant: AssistantMessage | undefined;

	function getPhases(): TodoPhase[] {
		return clonePhases(phases);
	}

	function setPhases(next: TodoPhase[]): void {
		phases = clonePhases(next);
	}

	const tracker = new TodoTracker({
		config: () => TODO_CONFIG,
		getPhases,
		setPhases: (next: TodoPhase[]) => setPhases(next),
		getBranch: (ctx) => ctx.sessionManager.getBranch(),
		hasPendingMessages: (ctx) => ctx.hasPendingMessages(),
		getActiveToolNames: () => pi.getActiveTools(),
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
		// model-only keeps the tool out of the codemode callable set (and out of
		// ctx.executeTool for any caller), so a wrapped call cannot drop the
		// durable record. The cost: a script cannot batch todo updates.
		exposure: "model-only",

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
			if (!outcome.readOnly) {
				setPhases(outcome.phases);
				if (outcome.storage === "session") {
					pi.appendEntry(TODO_SNAPSHOT_CUSTOM_TYPE, { phases: outcome.phases });
				}
			}
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

	pi.on("session_start", async (_event, ctx) => {
		if (!TODO_CONFIG.enabled) {
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

	pi.on("agent_before_settle", async (_event, ctx) => {
		const reminder = await tracker.checkCompletion(ctx, lastAssistant);
		if (reminder === null) return undefined;
		return {
			entries: [
				{
					type: "custom_message",
					customType: TODO_REMINDER_CUSTOM_TYPE,
					content: reminder,
					display: false,
				},
			],
			continue: true,
		};
	});
}
