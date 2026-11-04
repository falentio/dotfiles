import { describe, expect, it } from "bun:test";
import type {
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
	it("registers the todo tool and lifecycle events", () => {
		const { api, handlers, tools, flags } = makeRecordingAPI();
		todosExtension(api);

		for (const event of [
			"session_start",
			"session_tree",
			"session_compact",
			"before_agent_start",
			"tool_result",
			"context",
			"agent_end",
			"agent_before_settle",
		]) {
			expect(handlers.has(event)).toBe(true);
		}

		expect(flags).toEqual([]);

		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		expect(tool?.label).toBe("Todo");
		expect(tool?.executionMode).toBe("sequential");
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

	it("the tool schema requires op but prepareArguments infers it", () => {
		const { api, tools } = makeRecordingAPI();
		todosExtension(api);
		const tool = tools.find((t) => t.name === "todo");
		expect(tool).toBeDefined();
		if (!tool) return;

		const args = { list: [{ phase: "Work", items: ["a"] }] };
		expect(tool.prepareArguments?.(args)).toEqual({ ...args, op: "init" });
		expect(tool.prepareArguments?.({ task: "x" })).toEqual({ task: "x" });
	});

	it("prepareArguments normalizes shapes before inferring the op", () => {
		const { api, tools } = makeRecordingAPI();
		todosExtension(api);
		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		expect(tool.prepareArguments?.({ list: ["a"] })).toEqual({
			items: ["a"],
			op: "init",
		});
		expect(
			tool.prepareArguments?.({ op: "complete", list: { Build: ["a"] } }),
		).toEqual({
			list: [{ phase: "Build", items: ["a"] }],
			op: "init",
		});
	});

	it("the todo tool executes against branch-synced state", async () => {
		const { api, handlers, tools, entries } = makeRecordingAPI();
		todosExtension(api);

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
			{ op: "start", task: "from branch" },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		const text =
			result.content.find((part) => part.type === "text")?.text ?? "";
		expect(text).toContain("from branch");
		expect((result.details as Record<string, unknown>).phases).toBeUndefined();
		expect(entries).toEqual([
			{
				type: "custom",
				customType: TODO_SNAPSHOT_CUSTOM_TYPE,
				data: {
					v: 1,
					phases: [
						{
							name: "Work",
							tasks: [{ content: "from branch", status: "in_progress" }],
						},
					],
				},
			},
		]);
	});

	it("drops a phase that a restored session left empty", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{
				getBranch: () =>
					branchWithTodo([
						{ name: "Husk", tasks: [] },
						{ name: "Work", tasks: [{ content: "real", status: "pending" }] },
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
		const result = await tool.execute!(
			"call-1",
			{ op: "view" },
			undefined,
			undefined,
			ctx as ExtensionToolContext,
		);
		const text =
			result.content.find((part) => part.type === "text")?.text ?? "";
		expect(text).not.toContain("Husk");
		expect(text).toContain("real");
	});

	it("injects no eager prelude for a run started by a custom message", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);
		const ctx = makeContext({ cwd: "/tmp/project" });
		await dispatch(
			handlers,
			"session_start",
			{ type: "session_start", reason: "startup" },
			ctx,
		);
		const [result] = await dispatch(
			handlers,
			"before_agent_start",
			{
				type: "before_agent_start",
				messageType: "custom",
				message: {
					role: "custom",
					customType: "other-extension",
					content: "wake up",
					display: false,
				},
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("before_agent_start injects the configured eager prelude", async () => {
		const { api, handlers } = makeRecordingAPI();
		todosExtension(api);

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
			{ type: "before_agent_start", messageType: "user", prompt: "Build the feature" },
			ctx,
		);
		const message = (
			results[0] as {
				message?: { customType?: string; content?: string; display?: boolean };
			}
		)?.message;
		expect(message?.customType).toBe("eager-todo-prelude");
		expect(message?.display).toBe(false);
		expect(message?.content).toContain("Consider calling `todo` first");
		expect(message?.content).not.toContain("MUST");
	});

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
			{ type: "agent_before_settle", entries: [] },
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

	it("does not remind about todos the tool already completed", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
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

	it("appends the reminder to entries proposed by earlier handlers", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
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
		await dispatch(
			handlers,
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "Stopping here." }],
						stopReason: "stop",
					},
				],
			},
			ctx,
		);
		const earlier = {
			type: "custom_message",
			customType: "other-extension",
			content: "an entry proposed earlier",
			display: false,
		};
		const [result] = (await dispatch(
			handlers,
			"agent_before_settle",
			{ type: "agent_before_settle", entries: [earlier] },
			ctx,
		)) as [ReminderResult];
		expect(result?.entries?.map((entry) => entry.customType)).toEqual([
			"other-extension",
			"todo-reminder",
		]);
	});

	it("does not remind after completion", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
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
		await dispatch(
			handlers,
			"before_agent_start",
			{ type: "before_agent_start", messageType: "user", prompt: "Unrelated next prompt" },
			ctx,
		);
		const result = await settleAssistant(handlers, ctx);
		expect(result).toBeUndefined();
	});

	it("writes a todo_snapshot custom entry on a successful mutation", async () => {
		const { api, handlers, tools, entries } = makeRecordingAPI();
		todosExtension(api);
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
			v: 1,
			phases: [
				{
					name: "Tasks",
					tasks: [{ content: "Wire workspace", status: "in_progress" }],
				},
			],
		});
	});

	it("writes no snapshot without a session file", async () => {
		const { api, handlers, tools, entries } = makeRecordingAPI();
		todosExtension(api);
		const ctx = makeContext(
			{ cwd: "/tmp/project" },
			{ getBranch: () => [], getCwd: () => "/tmp/project", getSessionFile: () => undefined },
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
		expect(entries).toEqual([]);
	});

	it("writes nothing on a view or a failed mutation", async () => {
		const { api, handlers, tools, entries } = makeRecordingAPI();
		todosExtension(api);
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
		const [filtered] = (await dispatch(
			handlers,
			"context",
			{ type: "context", messages: [reminder, assistant] },
			ctx,
		)) as [{ messages: unknown[] }];
		expect(filtered?.messages).toEqual([assistant]);
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

		for (let i = 0; i < 20; i++) {
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

	it("a compaction makes the next status op return the full list", async () => {
		const { api, handlers, tools } = makeRecordingAPI();
		todosExtension(api);
		const phases = [
			{
				name: "Work",
				tasks: [
					{ content: "a", status: "in_progress" },
					{ content: "b", status: "pending" },
					{ content: "c", status: "pending" },
				],
			},
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
		await dispatch(handlers, "session_compact", { type: "session_compact" }, ctx);

		const tool = tools.find((t) => t.name === "todo");
		if (!tool) throw new Error("todo tool missing");
		const run = async (id: string, params: Parameters<typeof tool.execute>[1]) => {
			const result = await tool.execute!(
				id,
				params,
				undefined,
				undefined,
				ctx as ExtensionToolContext,
			);
			return result.content.find((part) => part.type === "text")?.text ?? "";
		};

		const afterCompact = await run("done", { op: "done", task: "a" });
		expect(afterCompact).toContain('Marked done: "a"');
		expect(afterCompact).toContain("  Work:");
		expect(afterCompact).not.toContain("Next:");

		const afterFullList = await run("start", { op: "start", task: "c" });
		expect(afterFullList).toContain('Started: "c"');
		expect(afterFullList).not.toContain("  Work:");
	});
});
