import { estimateTokens, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai/compat";

export const VERIFY_LOG_KEY = "__backgroundCompactionVerifyLog";

export const SUMMARY_MARKER = "SUMMARY-MARKER";
export const BLOAT_CHARS = 240_000;
export const SUMMARY_DELAY_MS = 300;
export const SLOW_DELAY_MS = 400;

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

function isSummaryRequest(context: Context): boolean {
	if ((context.systemPrompt ?? "").includes("context checkpoint summary")) return true;
	const first = context.messages[0];
	return first?.role === "user" && textOf(first.content).startsWith("<conversation>");
}

function usageFor(context: Context): Usage {
	const input = context.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
	return {
		input,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	model: Model<string>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	usage: Usage,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function finish(
	stream: ReturnType<typeof createAssistantMessageEventStream>,
	message: AssistantMessage,
	reason: "stop" | "toolUse",
): void {
	stream.push({ type: "done", reason, message });
}

function streamMock(model: Model<string>, context: Context) {
	const stream = createAssistantMessageEventStream();
	const log = currentLog();
	const summary = isSummaryRequest(context);
	const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
	const lastUserText = lastUser ? textOf(lastUser.content) : "";
	const request: VerifyRequest = {
		seq: log.seq++,
		summary,
		lastUserText,
		texts: context.messages.map((message) => textOf(message.content).slice(0, 500)),
		roles: context.messages.map((message) => message.role),
	};
	log.requests.push(request);
	if (summary) {
		log.summaryInFlight += 1;
		log.maxSummaryInFlight = Math.max(log.maxSummaryInFlight, log.summaryInFlight);
	}

	const usage = usageFor(context);

	if (summary) {
		const reply = assistantMessage(
			model,
			[{ type: "text", text: `${SUMMARY_MARKER}\n## Goal\nKeep the test session working.` }],
			"stop",
			usage,
		);
		setTimeout(() => {
			log.summaryInFlight -= 1;
			request.endedSeq = log.seq++;
			finish(stream, reply, "stop");
		}, SUMMARY_DELAY_MS);
		return stream;
	}

	const last = context.messages.at(-1);
	const delay = /slow/.test(lastUserText) ? SLOW_DELAY_MS : 0;

	setTimeout(() => {
		if (last?.role === "toolResult") {
			finish(stream, assistantMessage(model, [{ type: "text", text: `done ${lastUserText}` }], "stop", usage), "stop");
			return;
		}
		if (/\bsimple\b/.test(lastUserText)) {
			finish(stream, assistantMessage(model, [{ type: "text", text: `simple ${lastUserText}` }], "stop", usage), "stop");
			return;
		}
		const chars = /\bmedium\b/.test(lastUserText) ? 10_000 : BLOAT_CHARS;
		const toolCall = {
			type: "toolCall" as const,
			id: `call-${request.seq}`,
			name: "bloat",
			arguments: { chars },
		};
		finish(stream, assistantMessage(model, [toolCall], "toolUse", usage), "toolUse");
	}, delay);

	return stream;
}

export default function mockProvider(pi: ExtensionAPI): void {
	registerApiProvider(
		{ api: "bgc-mock-api", stream: streamMock as never, streamSimple: streamMock },
		"bgc-mock-verify",
	);
	pi.registerProvider("bgc-mock", {
		name: "Background compaction mock",
		baseUrl: "http://127.0.0.1/mock",
		apiKey: "test-key",
		api: "bgc-mock-api",
		models: [
			{
				id: "mock-model",
				name: "Mock model",
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
		parameters: { type: "object", properties: { chars: { type: "number" } } } as never,
		execute: async (_toolCallId, params) => {
			const requested = (params as { chars?: number }).chars;
			const chars = typeof requested === "number" ? requested : BLOAT_CHARS;
			return { content: [{ type: "text", text: "b".repeat(chars) }], details: { chars } };
		},
	});
}
