/**
 * In-process fake model: no HTTP, no server, no cost.
 *
 *   pi -e prototypes/pi-mock-llm/faux-probe.ts --provider faux --model faux-1 -p "tell me a story"
 *
 * `fauxProvider` is pi-ai's own test double. The response factory below is
 * called for every model request, so behaviour can depend on the prompt.
 */

import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STORY =
	"The lighthouse keeper climbed the spiral stairs each evening, counting the steps out of habit. " +
	"When the storm came in from the north, he stayed awake feeding the lamp and talking to the gulls.";

const respond = (context: Context) => {
	const text = JSON.stringify(context.messages);
	if (/summar/i.test(text)) {
		return fauxAssistantMessage("## Summary\n\n- Fake model wrote this summary in-process.");
	}
	if (/list files/i.test(text)) {
		return fauxAssistantMessage([fauxToolCall("bash", { command: "ls" })]);
	}
	return fauxAssistantMessage(STORY);
};

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({
		provider: "faux",
		models: [
			{
				id: "faux-1",
				name: "Faux 1",
				contextWindow: 8_000,
				maxTokens: 4_096,
			},
		],
	});

	// The faux queue pops one entry per model call; queue plenty for a session.
	faux.setResponses(Array.from({ length: 64 }, () => respond));

	pi.registerProvider(faux.provider);
}
