import { getApiProvider, registerApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const VERIFY_LOG_KEY = "__idleCompactVerifyLog";
export const FAUX_API = "idle-compact-faux";
export const FAUX_PROVIDER = "idle-compact-faux";
export const FAUX_MODEL = "faux-1";
export const SUMMARY_MARKER = "SUMMARY-MARKER";
export const BLOAT_CHARS = 240_000;
export const CONTEXT_WINDOW = 200_000;
export const MAX_TOKENS = 4_096;

export interface VerifyRequest {
	readonly summary: boolean;
	readonly lastUserText: string;
	readonly texts: readonly string[];
	readonly roles: readonly string[];
}

export interface VerifyLog {
	requests: VerifyRequest[];
}

export function emptyLog(): VerifyLog {
	return { requests: [] };
}

function currentLog(): VerifyLog {
	const store = globalThis as Record<string, unknown>;
	if (store[VERIFY_LOG_KEY] === undefined) store[VERIFY_LOG_KEY] = emptyLog();
	return store[VERIFY_LOG_KEY] as VerifyLog;
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
};

const message = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "faux",
	provider: "faux",
	model: FAUX_MODEL,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason,
	timestamp: Date.now(),
});

let nextToolId = 0;

const toolCall = (name: string, args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: `probe-tool-${nextToolId++}`,
	name,
	arguments: args,
});

// pi asks for the history summary with <conversation>, and for a split turn
// with a # Conversation prompt.
function isSummaryRequest(context: {
	systemPrompt?: string;
	messages: Array<{ role: string; content: unknown }>;
}): boolean {
	if ((context.systemPrompt ?? "").includes("context checkpoint summary")) return true;
	return context.messages.some((item) => {
		if (item.role !== "user") return false;
		const text = textOf(item.content);
		return text.startsWith("<conversation>") || text.startsWith("# Conversation");
	});
}

const respond = async (context: {
	systemPrompt?: string;
	messages: Array<{ role: string; content: unknown }>;
}): Promise<AssistantMessage> => {
	const log = currentLog();
	const summary = isSummaryRequest(context);
	const lastUser = [...context.messages].reverse().find((item) => item.role === "user");
	const lastUserText = lastUser ? textOf(lastUser.content) : "";
	log.requests.push({
		summary,
		lastUserText,
		texts: context.messages.map((item) => textOf(item.content).slice(0, 500)),
		roles: context.messages.map((item) => item.role),
	});

	if (summary) {
		return message([{ type: "text", text: `${SUMMARY_MARKER}\n## Goal\nKeep the smoke session working.` }]);
	}

	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		return message([{ type: "text", text: `done ${lastUserText}` }]);
	}
	return message([toolCall("bloat", { chars: BLOAT_CHARS })], "toolUse");
};

export default function probe(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		api: FAUX_API,
		provider: FAUX_PROVIDER,
		models: [{ id: FAUX_MODEL, name: "Faux model", contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS }],
	});
	faux.setResponses(Array.from({ length: 64 }, () => respond));

	// Faux counts cacheWrite inside input as well, so a cached prompt inflates
	// totalTokens. The extension reads usage to decide when to compact, so the
	// fake answers without a prompt cache and every turn costs its real prompt.
	const base = getApiProvider(FAUX_API);
	if (base) {
		registerApiProvider(
			{
				api: FAUX_API,
				stream: (model, context, options) => base.stream(model, context, options && { ...options, sessionId: undefined }),
				streamSimple: (model, context, options) =>
					base.streamSimple(model, context, options && { ...options, sessionId: undefined }),
			},
			"idle-compact-faux-no-cache",
		);
	}

	pi.registerProvider(FAUX_PROVIDER, {
		name: "Idle compact faux",
		baseUrl: "http://127.0.0.1/faux",
		apiKey: "test-key",
		api: FAUX_API,
		models: [
			{
				id: FAUX_MODEL,
				name: "Faux model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: CONTEXT_WINDOW,
				maxTokens: MAX_TOKENS,
			},
		],
	});

	pi.registerTool({
		name: "bloat",
		label: "Bloat",
		description: "Return a large deterministic payload.",
		parameters: { type: "object", properties: { chars: { type: "number" } }, additionalProperties: false },
		execute: async (_toolCallId: string, params: { chars?: number }) => {
			const chars = params.chars ?? BLOAT_CHARS;
			return { content: [{ type: "text" as const, text: "b".repeat(chars) }], details: { chars } };
		},
	});
}
