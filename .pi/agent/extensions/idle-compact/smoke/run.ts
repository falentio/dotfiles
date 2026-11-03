import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti/static";
import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { findPiInstall, piAliases } from "../../../test-support/pi-install.mjs";
import {
	CONTEXT_WINDOW,
	FAUX_API,
	FAUX_MODEL,
	FAUX_PROVIDER,
	MAX_TOKENS,
	SUMMARY_MARKER,
	VERIFY_LOG_KEY,
	emptyLog,
	type VerifyLog,
	type VerifyRequest,
} from "./probe.ts";

export type Scenario = "idle-compact" | "none";

export interface Result {
	readonly compactions: number;
	readonly events: readonly string[];
	readonly summaryRequests: number;
	readonly markedRequests: number;
	readonly last: VerifyRequest | undefined;
}

const HERE = import.meta.dir;
const SOURCE = join(HERE, "..");
const PROBE = join(HERE, "probe.ts");
const PI_INSTALL = findPiInstall();
const SETTLE_MS = 50;
const POLL_MS = 25;
const WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function modelFor() {
	return {
		id: FAUX_MODEL,
		name: "Faux model",
		api: FAUX_API,
		provider: FAUX_PROVIDER,
		baseUrl: "http://127.0.0.1/faux",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
	};
}

function prepareAgentDir(agentDir: string, scenario: Scenario): void {
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	copyFileSync(PROBE, join(agentDir, "extensions", "probe.ts"));
	if (scenario === "none") return;

	const extensionDir = join(agentDir, "extensions", "idle-compact");
	mkdirSync(extensionDir, { recursive: true });
	for (const file of ["index.ts", "state.ts", "package.json"]) {
		copyFileSync(join(SOURCE, file), join(extensionDir, file));
	}
	const config = readFileSync(join(SOURCE, "config.ts"), "utf8").replace(/(idleMs: )\d[^,\n]*/, "$1 0");
	writeFileSync(join(extensionDir, "config.ts"), config);
}

function logOf(): VerifyLog {
	const store = globalThis as Record<string, unknown>;
	if (store[VERIFY_LOG_KEY] === undefined) store[VERIFY_LOG_KEY] = emptyLog();
	return store[VERIFY_LOG_KEY] as VerifyLog;
}

async function loadProbe(): Promise<void> {
	const jiti = createJiti(import.meta.url, { moduleCache: false, alias: piAliases(PI_INSTALL) });
	const factory = (await jiti.import(PROBE, { default: true })) as (pi: unknown) => void;
	factory({ registerTool() {}, registerProvider() {} });
}

// The compaction starts on a later microtask than the swallowed prompt, so the
// end of the second prompt is not the end of the scenario: wait for a settled
// request that carries the re-sent text.
async function waitForSettledRequest(session: AgentSession, text: string): Promise<void> {
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		const last = logOf().requests.at(-1);
		if (session.isIdle && last !== undefined && !last.summary && last.lastUserText.includes(text)) return;
		await session.waitForIdle();
		await sleep(POLL_MS);
	}
	throw new Error(`the session never settled on a request carrying "${text}"`);
}

export async function run(scenario: Scenario): Promise<Result> {
	const cwd = mkdtempSync(join(tmpdir(), "idle-compact-project-"));
	const agentDir = mkdtempSync(join(tmpdir(), "idle-compact-agent-"));
	prepareAgentDir(agentDir, scenario);
	(globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] = emptyLog();
	await loadProbe();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model: modelFor() as never,
		thinkingLevel: "off",
		tools: ["bloat"],
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({}),
	});

	const events: string[] = [];
	session.subscribe((event) => {
		if (event.type === "compaction_start") events.push(`start:${event.reason}`);
	});

	await session.prompt("bloat turn 1");
	await session.waitForIdle();
	await sleep(SETTLE_MS);
	await session.prompt("bloat turn 2");
	await waitForSettledRequest(session, "bloat turn 2");

	const requests = logOf().requests;
	return {
		compactions: session.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length,
		events,
		summaryRequests: requests.filter((request) => request.summary).length,
		markedRequests: requests.filter((request) => request.texts.some((text) => text.includes(SUMMARY_MARKER))).length,
		last: requests.at(-1),
	};
}
