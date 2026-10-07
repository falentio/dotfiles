/**
 * Shared test stubs: a recording ExtensionAPI and an ExtensionContext factory.
 * The real pi runtime is not loaded in tests; these stand in for the host so
 * the extension factory and its event handlers can be exercised directly.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type AnyHandler = ExtensionHandler<ExtensionEvent, unknown>;
type RegisterFlagOptions = Parameters<ExtensionAPI["registerFlag"]>[1];

export interface RecordingAPI {
	api: ExtensionAPI;
	handlers: Map<string, AnyHandler[]>;
	tools: ToolDefinition[];
	commands: string[];
	flags: Array<{ name: string; options: RegisterFlagOptions }>;
}

export function makeRecordingAPI(): RecordingAPI {
	const handlers = new Map<string, AnyHandler[]>();
	const tools: ToolDefinition[] = [];
	const commands: string[] = [];
	const flags: Array<{ name: string; options: RegisterFlagOptions }> = [];

	const api: ExtensionAPI = {
		on: ((event: string, handler: AnyHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		}) as ExtensionAPI["on"],
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: (name: string) => {
			commands.push(name);
		},
		registerShortcut: () => {},
		registerFlag: (name: string, options: RegisterFlagOptions) => {
			flags.push({ name, options });
		},
		getFlag: () => undefined,
		registerMessageRenderer: () => {},
		registerMarkdownTransformer: () => {},
		registerEntryRenderer: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		exec: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
		getActiveTools: () => ["todo", "bash"],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: () => Promise.resolve(true),
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		events: {
			on: () => () => {},
			emit: () => {},
			off: () => {},
		},
	} as unknown as ExtensionAPI;

	return { api, handlers, tools, commands, flags };
}

export function makeContext(
	overrides: Partial<ExtensionContext> = {},
	sm: Partial<ExtensionContext["sessionManager"]> = {},
): ExtensionContext {
	const sessionManager = {
		getCwd: () => "/tmp",
		getSessionDir: () => "/tmp",
		getSessionId: () => "test",
		getSessionFile: () => "/tmp/session.jsonl",
		getLeafId: () => null,
		getLeafEntry: () => undefined,
		getEntry: () => undefined,
		getLabel: () => undefined,
		getBranch: () => [],
		buildContextEntries: () => [],
		getHeader: () => null,
		getEntries: () => [],
		getTree: () => [],
		getSessionName: () => undefined,
		...sm,
	} as ExtensionContext["sessionManager"];
	return {
		ui: {
			select: () => Promise.resolve(undefined),
			confirm: () => Promise.resolve(false),
			input: () => Promise.resolve(undefined),
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: () => Promise.resolve(undefined),
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: () => Promise.resolve(undefined),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: true }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		},
		mode: "print",
		hasUI: false,
		cwd: "/tmp",
		sessionManager,
		modelRegistry: {} as never,
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	} as unknown as ExtensionContext;
}

export async function dispatch(
	handlers: Map<string, AnyHandler[]>,
	event: string,
	eventPayload: unknown,
	ctx: ExtensionContext,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of handlers.get(event) ?? []) {
		results.push(await handler(eventPayload as never, ctx));
	}
	return results;
}

export function branchWithTodo(
	phases: unknown,
): { type: string; message: Record<string, unknown> }[] {
	return [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { op: "init", phases, storage: "session" },
			},
		},
	];
}
