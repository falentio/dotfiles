import { getApiProvider, registerApiProvider, registerFauxProvider, Type } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const VERIFY_LOG_KEY = "__backgroundCompactionVerifyLog";

export const FAUX_API = "bgc-faux-api";
export const FAUX_PROVIDER = "bgc-faux";
export const FAUX_MODEL = "faux-1";
export const SUMMARY_MARKER = "SUMMARY-MARKER";
export const BLOAT_CHARS = 240_000;
export const SUMMARY_DELAY_MS = 300;
export const SLOW_DELAY_MS = 400;

const bloatParameters = Type.Object({ chars: Type.Optional(Type.Number()) });

export interface VerifyRequest {
	seq: number;
	endedSeq?: number;
	summary: boolean;
	lastUserText: string;
	texts: string[];
	roles: string[];
}

export interface VerifyLog {
	seq: number;
	requests: VerifyRequest[];
	events: Array<{ kind: string; seq: number; reason?: string; text?: string }>;
	summaryInFlight: number;
	maxSummaryInFlight: number;
}

export function emptyVerifyLog(): VerifyLog {
	return { seq: 0, requests: [], events: [], summaryInFlight: 0, maxSummaryInFlight: 0 };
}

function currentLog(): VerifyLog {
	const global = globalThis as Record<string, unknown>;
	if (!global[VERIFY_LOG_KEY]) global[VERIFY_LOG_KEY] = emptyVerifyLog();
	return global[VERIFY_LOG_KEY] as VerifyLog;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

// pi asks for the history summary with <conversation>, and for a split turn
// with a # Conversation prompt.
function isSummaryRequest(context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown }> }): boolean {
	if ((context.systemPrompt ?? "").includes("context checkpoint summary")) return true;
	return context.messages.some((message) => {
		if (message.role !== "user") return false;
		const text = textOf(message.content);
		return text.startsWith("<conversation>") || text.startsWith("# Conversation");
	});
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const message = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
	role: "assistant",
	content,
	api: FAUX_API,
	provider: FAUX_PROVIDER,
	model: FAUX_MODEL,
	usage,
	stopReason,
	timestamp: Date.now(),
});

let nextToolId = 0;

const toolCall = (name: string, args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: `faux-tool-${nextToolId++}`,
	name,
	arguments: args,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const respond = async (context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown }> }) => {
	const log = currentLog();
	const summary = isSummaryRequest(context);
	const lastUser = [...context.messages].reverse().find((item) => item.role === "user");
	const lastUserText = lastUser ? textOf(lastUser.content) : "";
	const request: VerifyRequest = {
		seq: log.seq++,
		summary,
		lastUserText,
		texts: context.messages.map((item) => textOf(item.content).slice(0, 500)),
		roles: context.messages.map((item) => item.role),
	};
	log.requests.push(request);

	if (summary) {
		log.summaryInFlight += 1;
		log.maxSummaryInFlight = Math.max(log.maxSummaryInFlight, log.summaryInFlight);
		await sleep(SUMMARY_DELAY_MS);
		log.summaryInFlight -= 1;
		request.endedSeq = log.seq++;
		return message([{ type: "text", text: `${SUMMARY_MARKER}\n## Goal\nKeep the test session working.` }]);
	}

	const last = context.messages.at(-1);
	await sleep(/slow/.test(lastUserText) ? SLOW_DELAY_MS : 0);
	if (last?.role === "toolResult") {
		return message([{ type: "text", text: `done ${lastUserText}` }]);
	}
	if (/\bsimple\b/.test(lastUserText)) {
		return message([{ type: "text", text: `simple ${lastUserText}` }]);
	}
	const chars = /\bmedium\b/.test(lastUserText) ? 10_000 : BLOAT_CHARS;
	return message([toolCall("bloat", { chars })], "toolUse");
};

export default function fauxProvider(pi: ExtensionAPI): void {
	const faux = registerFauxProvider({
		api: FAUX_API,
		provider: FAUX_PROVIDER,
		models: [{ id: FAUX_MODEL, name: "Faux model", contextWindow: 200_000, maxTokens: 4_096 }],
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
			"bgc-faux-no-cache",
		);
	}

	pi.registerProvider(FAUX_PROVIDER, {
		name: "Background compaction faux",
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
				contextWindow: 200_000,
				maxTokens: 4_096,
			},
		],
	});

	pi.registerTool({
		name: "bloat",
		label: "Bloat",
		description: "Return a large deterministic payload.",
		parameters: bloatParameters,
		execute: async (_toolCallId, params) => {
			const chars = params.chars ?? BLOAT_CHARS;
			return { content: [{ type: "text", text: "b".repeat(chars) }], details: { chars } };
		},
	});
}
