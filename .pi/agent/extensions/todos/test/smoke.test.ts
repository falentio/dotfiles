/**
 * Smoke test: the extension factory runs against a recording ExtensionAPI
 * stub and registers the tool, flags, and events it should, and the event
 * handlers actually dispatch: session sync, eager prelude injection,
 * reminders, context pruning, and the mid-run nudge.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import todosExtension from "../index.ts";
import { TODO_SNAPSHOT_CUSTOM_TYPE } from "../persistence.ts";
import {
	branchWithTodo,
	dispatch,
	makeContext,
	makeRecordingAPI,
	type AnyHandler,
} from "./helpers.ts";

describe("todos extension factory", () => {
	let tempRoot = "";
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	afterEach(() => {
		if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
		tempRoot = "";
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	function sandboxAgentDir(): string {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "todos-smoke-"));
		const agent = path.join(tempRoot, "agent");
		fs.mkdirSync(agent, { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agent;
		return agent;
	}

	it("registers the todo tool, flags, and lifecycle events", () => {
		const { api, handlers, tools, flags } = makeRecordingAPI();
		todosExtension(api);

		for (const event of [
			"session_start",
			"session_tree",
			"session_compact",
			"before_agent_start",
			"resources_discover",
			"tool_result",
			"context",
			"agent_end",
			"agent_before_settle",
		]) {
			expect(handlers.has(event)).toBe(true);
		}

		expect(flags.map((flag) => flag.name)).toEqual([
			"todo-enabled",
			"todo-reminders",
			"todo-reminders-max",
			"todo-eager",
		]);

		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		expect(tool?.label).toBe("Todo");
		expect(tool?.executionMode).toBe("sequential");
		// Excluded from the codemode callable set so a wrapped call still records
		// the durable todo state, not just the outer codemode result.
		expect(tool?.exposure).toBe("model-only");
		expect(tool?.promptSnippet).toContain("structured todo list");
	});

	it("registers no /todo or /todos-configure command", () => {
		const { api, commands } = makeRecordingAPI();
		todosExtension(api);
		expect(commands).not.toContain("todo");
		expect(commands).not.toContain("todos-configure");
		expect(commands).toEqual([]);
	});

	it("contributes the bundled todo-discipline skill only when enabled", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext({ cwd: "/tmp/project" });

		// Default config (enabled): the skill path is offered and exists on disk.
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const [enabled] = (await dispatch(
			handlers,
			"resources_discover",
			{ type: "resources_discover", cwd: "/tmp/project", reason: "startup" },
			ctx,
		)) as [{ skillPaths?: string[] } | undefined];
		const skillPaths = enabled?.skillPaths ?? [];
		expect(skillPaths).toHaveLength(1);
		const skillFile = path.join(skillPaths[0] ?? "", "todo-discipline", "SKILL.md");
		expect(fs.existsSync(skillFile)).toBe(true);
		const skill = fs.readFileSync(skillFile, "utf8");
		expect(skill).toContain("name: todo-discipline");
		expect(skill).toContain("description:");

		// Globally disabled: no skill contribution.
		fs.writeFileSync(
			path.join(process.env.PI_CODING_AGENT_DIR ?? "", "todo.json"),
			JSON.stringify({ enabled: false }),
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "reload" },
			ctx,
		);
		const [disabled] = (await dispatch(
			handlers,
			"resources_discover",
			{ type: "resources_discover", cwd: "/tmp/project", reason: "startup" },
			ctx,
		)) as [{ skillPaths?: string[] } | undefined];
		expect(disabled?.skillPaths ?? []).toHaveLength(0);
	});

	it("the tool schema requires op but prepareArguments infers it", () => {
		const { api, tools } = makeRecordingAPI();
		todosExtension(api);
		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		if (!tool) return;

		const args = { list: [{ phase: "Work", items: ["a"] }] };
		expect(tool.prepareArguments?.(args)).toEqual({ ...args, op: "init" });
		// Uninferable shapes pass through and fail schema validation.
		expect(tool.prepareArguments?.({ task: "x" })).toEqual({ task: "x" });
	});

	it("the todo tool executes against branch-synced state", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();

		const phases = [
			{ name: "Work", tasks: [{ content: "from branch", status: "pending" }] },
		];
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => branchWithTodo(phases) as never,
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);

		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		if (!tool) return;

		const result = await tool.execute!(
			"call-1",
			{ op: "view" },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		const text =
			result.content.find((part) => part.type === "text")?.text ?? "";
		expect(text).toContain("from branch");
		// The branch result itself is the durable record.
		expect((result.details as { phases: unknown }).phases).toEqual(phases);
	});

	it("before_agent_start injects the eager prelude when configured", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		const agent = sandboxAgentDir();
		fs.writeFileSync(
			path.join(agent, "todo.json"),
			JSON.stringify({ eager: "always" }),
			"utf8",
		);

		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		const results = await dispatch(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "Build the feature" },
			ctx,
		);
		const message = (
			results[0] as {
				message?: { customType?: string; content?: string; display?: boolean };
			}
		)?.message;
		expect(message?.customType).toBe("eager-todo-prelude");
		expect(message?.display).toBe(false);
		expect(message?.content).toContain("MUST call `todo` first");
	});

	it("before_agent_start returns nothing on the default config", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();

		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const results = await dispatch(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "Build the feature" },
			ctx,
		);
		expect(results[0]).toBeUndefined();
	});

	async function makeEntryCapture(api: ExtensionAPI) {
		const entries: Array<{ customType: string; data: unknown }> = [];
		api.appendEntry = (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		};
		return entries;
	}

	async function settleAssistant(
		handlers: Map<string, AnyHandler[]>,
		ctx: ExtensionContext,
		text = "All current todos are done.",
	): Promise<unknown> {
		await dispatch(
			handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text }],
						stopReason: "stop",
					},
				],
			},
			ctx,
		);
		const [result] = await dispatch(
			handlers,
			"agent_before_settle",
			{ type: "agent_before_settle" },
			ctx,
		);
		return result;
	}

	interface ReminderResult {
		continue?: boolean;
		entries?: Array<{
			type: string;
			customType: string;
			content: string;
			display: boolean;
		}>;
	}

	// P1 regression: the tracker and the tool must share one canonical state,
	// so completing via the tool silences reminders; these reproduce the
	// "stale reminder … scaffold session" bug.
	it("does not remind about todos the tool already completed", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () =>
					branchWithTodo([
						{
							name: "Scaffold",
							tasks: [{ content: "scaffold crate", status: "pending" }],
						},
					]) as never,
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		await tool.execute!(
			"done-it",
			{ op: "done", task: "scaffold crate" },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		const result = (await settleAssistant(handlers, ctx)) as
			| ReminderResult
			| undefined;
		expect(result).toBeUndefined();
	});

	it("reminds about live incomplete todos", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		await tool.execute!(
			"init",
			{ op: "init", items: ["Wire workspace"] },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		const result = (await settleAssistant(
			handlers,
			ctx,
			"Stopping here.",
		)) as ReminderResult | undefined;
		expect(result?.continue).toBe(true);
		expect(result?.entries).toHaveLength(1);
		expect(result?.entries?.[0]?.type).toBe("custom_message");
		expect(result?.entries?.[0]?.customType).toBe("todo-reminder");
		expect(result?.entries?.[0]?.content).toContain("Wire workspace");
		expect(result?.entries?.[0]?.display).toBe(false);
	});

	it("does not remind after completion", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		await tool.execute!(
			"init",
			{ op: "init", items: ["Wire workspace"] },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		await tool.execute!(
			"done",
			{ op: "done", task: "Wire workspace" },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		// Completing between prompts and settling again sends nothing new —
		// resetCycle() must not resurrect stale tasks on the next prompt.
		await dispatch(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", prompt: "Unrelated next prompt" },
			ctx,
		);
		const result = await settleAssistant(handlers, ctx);
		expect(result).toBeUndefined();
	});

	it("writes a todo_snapshot custom entry on a successful mutation", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		const entries = await makeEntryCapture(api);
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () => [],
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		await tool.execute!(
			"init",
			{ op: "init", items: ["Wire workspace"] },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.customType).toBe(TODO_SNAPSHOT_CUSTOM_TYPE);
		expect(entries[0]?.data).toEqual({
			phases: [
				{
					name: "Tasks",
					tasks: [{ content: "Wire workspace", status: "in_progress" }],
				},
			],
		});
	});

	it("writes nothing on a view or a failed mutation", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		const entries = await makeEntryCapture(api);
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () =>
					branchWithTodo([
						{ name: "Work", tasks: [{ content: "a", status: "pending" }] },
					]) as never,
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		await tool.execute!(
			"view",
			{ op: "view" },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		await expect(
			tool.execute!(
				"missing",
				{ op: "done", task: "not there" },
				undefined,
				undefined,
				ctx as ExtensionToolContext,
			),
		).rejects.toThrow();
		expect(entries).toEqual([]);
	});

	it("prunes superseded tracker messages from outgoing context", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		sandboxAgentDir();
		const ctx = makeContext({ cwd: "/tmp/project" });
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const reminder = {
			role: "custom",
			customType: "todo-reminder",
			content: "You stopped with 1 incomplete todo item(s): scaffold",
			display: false,
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "All done." }],
		};
		// A reminder the assistant already answered leaves outgoing context.
		const [filtered] = (await dispatch(
			handlers,
			"context",
			{ type: "context", messages: [reminder, assistant] },
			ctx,
		)) as [{ messages: unknown[] }];
		expect(filtered?.messages).toEqual([assistant]);
		// A trailing reminder (the turn it triggered is in flight) stays: the
		// handler returns undefined = context left untouched.
		const [unchanged] = await dispatch(
			handlers,
			"context",
			{ type: "context", messages: [assistant, reminder] },
			ctx,
		);
		expect(unchanged).toBeUndefined();
	});

	it("tool_result nudges are steered into the session as custom messages", async () => {
		const sent: Array<{ customType: string; display: boolean }> = [];
		const { api, handlers } = makeRecordingAPI();
		api.sendMessage = (
			message: { customType: string; display: boolean },
			options?: unknown,
		) => {
			sent.push({ customType: message.customType, display: message.display });
			expect(options).toEqual({ deliverAs: "steer" });
		};
		todosExtension(api);
		sandboxAgentDir();

		// Seed state via session_start with an existing todo.
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () =>
					branchWithTodo([
						{ name: "Work", tasks: [{ content: "a", status: "pending" }] },
					]) as never,
				getCwd: () => "/tmp/project",
				getSessionFile: () => "/tmp/project/session.jsonl",
			},
		);
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);

		// 12 successful mutating tool results cross the nudge threshold.
		for (let i = 0; i < 12; i++) {
			await dispatch(
				handlers,
				"tool_result",
				{ type: "tool_result", toolName: "edit", isError: false },
				ctx,
			);
		}
		expect(sent).toHaveLength(1);
		expect(sent[0]?.customType).toBe("mid-run-todo-nudge");
	});
});
