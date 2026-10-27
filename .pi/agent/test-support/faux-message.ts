import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai/compat";

export const textOf = (content: unknown): string => {
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

// Faux replaces api, provider, model and usage before a message reaches pi, but
// AssistantMessage requires all four, so the placeholders below stay inert.
export const message = (
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage => ({
	role: "assistant",
	content,
	api: "faux",
	provider: "faux",
	model: "faux-1",
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

export const toolCall = (name: string, args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: `faux-tool-${nextToolId++}`,
	name,
	arguments: args,
});
