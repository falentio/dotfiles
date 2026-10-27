import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import { findPiInstall, piAliases } from "../../../test-support/pi-install.mjs";
import { FAUX_API, FAUX_MODEL, FAUX_PROVIDER, VERIFY_LOG_KEY, emptyVerifyLog } from "../faux-provider.ts";
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
const PROBE = join(SOURCE, "faux-provider.ts");
const FAUX_MESSAGE = join(SOURCE, "..", "..", "test-support", "faux-message.ts");

function modelFor(contextWindow: number) {
	return {
		id: FAUX_MODEL,
		name: "Faux model",
		api: FAUX_API,
		provider: FAUX_PROVIDER,
		baseUrl: "http://127.0.0.1/faux",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4_096,
	};
}

export interface RestartResult {
	first: Result & { turns: number; tokens: number | null; tokenSamples: number[] };
	second: Result & { turns: number; tokens: number | null; tokenSamples: number[] };
	sessionFile: string;
}

function prepareAgentDir(agentDir: string, scenario: Scenario): void {
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	// The provider imports the shared message helpers by a path relative to its
	// real home, so the temp tree needs that file at the same relative place.
	mkdirSync(join(agentDir, "test-support"), { recursive: true });
	copyFileSync(FAUX_MESSAGE, join(agentDir, "test-support", "faux-message.ts"));
	copyFileSync(PROBE, join(agentDir, "extensions", "faux-provider.ts"));
	if (scenario.extension !== "background-compaction") return;
	const extensionDir = join(agentDir, "extensions", "background-compaction");
	mkdirSync(extensionDir, { recursive: true });
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

export async function runTwice(scenario: Scenario): Promise<RestartResult> {
	const cwd = mkdtempSync(join(tmpdir(), "bgc-project-"));
	const agentDir = mkdtempSync(join(tmpdir(), "bgc-agent-"));
	prepareAgentDir(agentDir, scenario);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerProvider(FAUX_PROVIDER, {
		name: "Faux",
		baseUrl: "http://127.0.0.1/faux",
		apiKey: "test-key",
		api: FAUX_API,
		models: [
			{
				id: FAUX_MODEL,
				name: "Faux",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4_096,
			},
		],
	});

	await loadFauxProvider(PROBE);
	const sessionFile = join(cwd, "session.jsonl");
	const first = await driveOne(scenario, { cwd, agentDir, modelRuntime, sessionFile, create: true, forcedTurns: 0 });
	const reopened = first.sessionFile;
	const second = await driveOne(scenario, { cwd, agentDir, modelRuntime, sessionFile: reopened, create: false, forcedTurns: 2 });
	return {
		first: { ...first.result, turns: first.turns, tokens: first.tokens, tokenSamples: first.tokenSamples },
		second: { ...second.result, turns: second.turns, tokens: second.tokens, tokenSamples: second.tokenSamples },
		sessionFile: reopened,
	};
}

interface DriveOptions {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	sessionFile: string;
	create: boolean;
	forcedTurns: number;
}

async function driveOne(
	scenario: Scenario,
	options: DriveOptions,
): Promise<{ result: Result; sessionFile: string; turns: number; tokens: number | null; tokenSamples: number[] }> {
	const sessionManager = options.create
		? SessionManager.create(options.cwd, options.cwd)
		: SessionManager.open(options.sessionFile, options.cwd, options.cwd);
	(globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] = emptyVerifyLog();
	(globalThis as Record<string, unknown>).__probe = (globalThis as Record<string, unknown>)[VERIFY_LOG_KEY];
	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		model: modelFor(200_000) as never,
		modelRuntime: options.modelRuntime,
		thinkingLevel: "off",
		tools: ["bloat"],
		sessionManager,
		settingsManager: SettingsManager.inMemory({}),
	});

	const events: string[] = [];
	session.subscribe((event) => {
		if (event.type === "compaction_start") events.push(`start:${event.reason}`);
		if (event.type === "compaction_end") events.push(`end:${event.reason}`);
	});

	const recorder = () => (globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] as Probe;
	const tokenSamples: number[] = [];
	let turns = 0;
	const limit = Math.max(4, options.forcedTurns);
	for (let index = 1; index <= limit; index++) {
		if (turns >= options.forcedTurns && compactions(session.sessionManager).length > 0) break;
		await session.prompt(`bloat turn ${index}`);
		await session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		const used = session.getContextUsage()?.tokens ?? null;
		if (used !== null) tokenSamples.push(used);
		turns += 1;
	}
	const probe = recorder();
	const requests = probe?.requests ?? [];
	const file = session.sessionManager.getSessionFile();
	return {
		sessionFile: file ?? "missing",
		turns,
		tokens: tokenSamples.at(-1) ?? null,
		tokenSamples,
		result: {
			summaryRequests: requests.filter((request) => request.summary).length,
			compactions: compactions(session.sessionManager).map((entry) => ({
				fromHook: entry.fromHook ?? false,
				firstKeptEntryId: entry.firstKeptEntryId.slice(0, 8),
				tokensBefore: entry.tokensBefore,
			})),
			events,
			lastTexts: requests.at(-1)?.texts.length ?? 0,
		},
	};
}

export async function run(scenario: Scenario): Promise<Result> {
	const cwd = mkdtempSync(join(tmpdir(), "bgc-project-"));
	const agentDir = mkdtempSync(join(tmpdir(), "bgc-agent-"));
	prepareAgentDir(agentDir, scenario);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	if (scenario.modelContextWindow) {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[FAUX_PROVIDER]: {
						name: "Faux",
						baseUrl: "http://127.0.0.1/faux",
						apiKey: "test-key",
						api: FAUX_API,
						models: [
							{
								id: FAUX_MODEL,
								name: "Faux",
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
	modelRuntime.registerProvider(FAUX_PROVIDER, {
		name: "Faux",
		baseUrl: "http://127.0.0.1/faux",
		apiKey: "test-key",
		api: FAUX_API,
		models: [
			{
				id: FAUX_MODEL,
				name: "Faux",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: scenario.modelContextWindow ?? 200_000,
				maxTokens: 4_096,
			},
		],
	});

	(globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] = emptyVerifyLog();
	await loadFauxProvider(PROBE);
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

const PI_INSTALL = findPiInstall();

async function loadFauxProvider(path: string): Promise<void> {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: piAliases(PI_INSTALL) as Record<string, string>,
	});
	const factory = (await jiti.import(path, { default: true })) as (pi: unknown) => void;
	factory({ registerTool() {}, registerProvider() {} });
}

