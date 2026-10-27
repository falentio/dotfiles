import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Message {
	role: string;
	content: unknown;
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
		.join("");
};

let nextToolId = 0;

const toolCall = (name: string, args: ToolCall["arguments"]): ToolCall => ({
	type: "toolCall",
	id: `faux-tool-${nextToolId++}`,
	name,
	arguments: args,
});

const message = (
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

const respond = (context: { messages: Message[] }) => {
	const last = context.messages.at(-1);
	if (last?.role !== "user") return message([{ type: "text", text: "DONE" }]);

	const prompt = textOf(last.content);
	const edit = /Use the edit tool on ([\w./-]+\.\w+) to replace the exact string `([^`]+)` with `([^`]+)`/.exec(prompt);
	if (edit) {
		const [, path, oldText, newText] = edit;
		return message([toolCall("edit", { path, edits: [{ oldText, newText }] })], "toolUse");
	}

	const read = /Read ([\w./-]+\.\w+)(?: then read ([\w./-]+\.\w+))?/.exec(prompt);
	if (read) {
		const paths = read.slice(1).filter((path): path is string => Boolean(path));
		return message(paths.map((path) => toolCall("read", { path })), "toolUse");
	}

	return message([{ type: "text", text: "DONE" }]);
};

export default function fauxModel(pi: ExtensionAPI) {
	const faux = registerFauxProvider({
		provider: "faux",
		models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000, maxTokens: 4_096 }],
	});
	faux.setResponses(Array.from({ length: 32 }, () => respond));
	pi.registerProvider("faux", {
		name: "Faux",
		baseUrl: "http://localhost:0",
		apiKey: "unused",
		api: faux.api,
		models: [{ id: "faux-1", name: "Faux 1", contextWindow: 200_000, maxTokens: 4_096 }],
	});
}
