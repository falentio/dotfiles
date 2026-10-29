import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

function model(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 200_000,
		maxTokens: 4_096,
	};
}

export default function testProvider(pi: ExtensionAPI): void {
	for (const name of ["bandar", "other"]) {
		pi.registerProvider(name, {
			name,
			baseUrl: process.env.PROVIDER_BASE_URL,
			apiKey: "test",
			api: "openai-completions",
			models: [model(`${name}-1`)],
		});
	}
}
