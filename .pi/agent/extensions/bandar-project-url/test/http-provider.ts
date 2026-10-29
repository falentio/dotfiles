import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function wireProvider(pi: ExtensionAPI): void {
	pi.registerProvider("wire", {
		name: "Wire",
		baseUrl: process.env.WIRE_BASE_URL,
		apiKey: "test",
		api: "openai-completions",
		models: [
			{
				id: "wire-1",
				name: "Wire 1",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 200_000,
				maxTokens: 4_096,
			},
		],
	});
}
