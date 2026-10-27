import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { VERIFY_LOG_KEY, emptyVerifyLog } from "./mock-provider.ts";
import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export interface Scenario {
	extension: "background-compaction" | "none";
	compactWhenReady?: string;
	modelContextWindow?: number;
	keepRecentTokens?: number;
	tailMin?: number;
}

export interface Result {
	summaryRequests: number;
	compactions: Array<{ fromHook: boolean; firstKeptEntryId: string; tokensBefore: number }>;
	events: string[];
	lastTexts: number;
}

const HERE = import.meta.dir;
const SOURCE = join(HERE, "..");
const PROBE = join(HERE, "mock-provider.ts");
const API = "bgc-mock-api";

function modelFor(contextWindow: number) {
	return {
		id: "mock-model",
		name: "Mock model",
		api: API,
		provider: "bgc-mock",
		baseUrl: "http://127.0.0.1/mock",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4_096,
	};
}

export async function run(scenario: Scenario): Promise<Result> {
	const cwd = mkdtempSync(join(tmpdir(), "bgc-project-"));
	const agentDir = mkdtempSync(join(tmpdir(), "bgc-agent-"));
	const extensionDir = join(agentDir, "extensions", "background-compaction");
	mkdirSync(extensionDir, { recursive: true });

	if (scenario.extension === "background-compaction") {
		for (const file of ["index.ts", "boundary.ts", "state.ts", "package.json"]) {
			copyFileSync(join(SOURCE, file), join(extensionDir, file));
		}
		let config = readFileSync(join(SOURCE, "config.ts"), "utf8");
		if (scenario.compactWhenReady) {
			config = config.replace(/(compactWhenReady: )(true|false)/, `$1${scenario.compactWhenReady}`);
		}
		if (scenario.keepRecentTokens) {
			config = config.replace(/(keepRecentTokens: )\d[\d_]*/, `$1${scenario.keepRecentTokens}`);
		}
		if (scenario.tailMin) {
			config = config.replace(/(tailMin: )\d[\d_]*/, `$1${scenario.tailMin}`);
		}
			writeFileSync(join(extensionDir, "config.ts"), config);
	}

	copyFileSync(PROBE, join(agentDir, "extensions", "mock-provider.ts"));

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	if (scenario.modelContextWindow) {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"bgc-mock": {
						name: "Mock",
						baseUrl: "http://127.0.0.1/mock",
						apiKey: "test-key",
						api: API,
						models: [
							{
								id: "mock-model",
								name: "Mock",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: scenario.modelContextWindow,
								maxTokens: 4_096,
							},
						],
					},
				},
			}),
		);
	}
	modelRuntime.registerProvider("bgc-mock", {
		name: "Mock",
		baseUrl: "http://127.0.0.1/mock",
		apiKey: "test-key",
		api: API,
		models: [
			{
				id: "mock-model",
				name: "Mock",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: scenario.modelContextWindow ?? 200_000,
				maxTokens: 4_096,
			},
		],
	});

	(globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] = emptyVerifyLog();
	await loadMockProvider(PROBE);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: modelFor(scenario.modelContextWindow ?? 200_000) as never,
		thinkingLevel: "off",
		tools: ["bloat"],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({}),
	});

	const events: string[] = [];

	session.subscribe((event) => {
		if (event.type === "compaction_start") events.push(`start:${event.reason}`);
		if (event.type === "compaction_end") events.push(`end:${event.reason}`);
	});

	const recorder = () => (globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] as Probe;

	for (let index = 1; index <= 6; index++) {
		if (compactions(session.sessionManager).length > 0) break;
		await session.prompt(`bloat turn ${index}`);
		await session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 1_200));

	}

	const probe = recorder();
	const requests = probe?.requests ?? [];
	const last = requests.at(-1);
	return {
		summaryRequests: requests.filter((request) => request.summary).length,
		compactions: compactions(session.sessionManager).map((entry) => ({
			fromHook: entry.fromHook ?? false,
			firstKeptEntryId: entry.firstKeptEntryId.slice(0, 8),
			tokensBefore: entry.tokensBefore,
		})),
		events,
		lastTexts: last?.texts.length ?? 0,
	};
}

interface Probe {
	requests: Array<{ summary: boolean; texts: string[] }>;
}

function compactions(sessionManager: SessionManager) {
	return sessionManager.getEntries().filter((entry) => entry.type === "compaction") as Array<{
		fromHook?: boolean;
		firstKeptEntryId: string;
		tokensBefore: number;
	}>;
}

const PI_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent");
const AI_ROOT = join(PI_ROOT, "node_modules", "@earendil-works", "pi-ai", "dist");

function piAliases(): Record<string, string> {
	return {
		"@earendil-works/pi-coding-agent": join(PI_ROOT, "dist", "index.js"),
		"@earendil-works/pi-ai/compat": join(AI_ROOT, "compat.js"),
		"@earendil-works/pi-ai": join(AI_ROOT, "compat.js"),
		"@earendil-works/pi-agent-core": join(PI_ROOT, "node_modules", "@earendil-works", "pi-agent-core", "dist", "index.js"),
		"@earendil-works/pi-tui": join(PI_ROOT, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
	};
}

async function loadMockProvider(path: string): Promise<void> {
	const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piAliases() });
	const factory = (await jiti.import(path, { default: true })) as (pi: unknown) => void;
	factory({ registerTool() {}, registerProvider() {} });
}

