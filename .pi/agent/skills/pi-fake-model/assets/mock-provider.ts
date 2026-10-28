/**
 * Registers the local mock as a pi provider.
 *
 *   node prototypes/pi-mock-llm/server.mjs --port 8787 &
 *   pi -e prototypes/pi-mock-llm/mock-provider.ts --provider mock --model mock-1 -p "hello"
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const port = Number(process.env.MOCK_LLM_PORT ?? 8787);

export default function (pi: ExtensionAPI) {
	pi.registerProvider("mock", {
		name: "Mock LLM",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		apiKey: "mock-key",
		api: "openai-completions",
		models: [
			{
				id: "mock-1",
				name: "Mock 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: Number(process.env.MOCK_CONTEXT_WINDOW ?? 32_000),
				maxTokens: Number(process.env.MOCK_MAX_TOKENS ?? 4_096),
			},
		],
	});
}
