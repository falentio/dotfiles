import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { piCommand } from "../../test-support/pi-install.mjs";
import { CONFIG } from "./config.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = path.join(EXTENSION_DIR, "index.ts");
const FAUX_PROVIDER = path.join(EXTENSION_DIR, "smoke", "faux-provider.ts");
function piBinary(): string {
	const [command] = piCommand();
	if (!command) throw new Error("piCommand returned no command");
	return command;
}

const PI_BIN = piBinary();
const PI_ARGS = piCommand().slice(1);

const SMALL_WINDOW = 6000;
const GATE_WINDOW = 24_000;
const LARGE_WINDOW = 900_000;
const PROMPT = "Read big.txt three times. Then say DONE.";
const BIG_FILE_BYTES = 43_200;
const MARKER_NEEDLE = CONFIG.marker.trim();
const PRUNED_CHARS = CONFIG.headChars + CONFIG.marker.length + CONFIG.tailChars;

interface Call {
	n: number;
	kind: "summary" | "turn";
}

interface CompactionEntry {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	fromHook?: boolean;
	details?: { readFiles: string[]; modifiedFiles: string[] };
}

interface Usage {
	cacheRead: number;
	cacheWrite: number;
	input: number;
	output: number;
}

interface Entry {
	type?: string;
	summary?: string;
	firstKeptEntryId?: string;
	fromHook?: boolean;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	message?: {
		role?: string;
		content?: Array<{ type?: string; id?: string; text?: string }>;
		toolCallId?: string;
		usage?: Partial<Usage>;
	};
}

interface Scenario {
	name: string;
	window: number;
	extension: boolean;
	/** Omitted: the project settings leave pi's own default reserve in charge. */
	reserveTokens?: number;
	/** Prompt text before the task. A prune cannot shrink it, so the drop runs. */
	padding?: number;
}

interface Run {
	calls: Call[];
	requests: string[];
	compactions: CompactionEntry[];
	usage: Usage;
	entries: Entry[];
}

const SCENARIOS = {
	small: { name: "small", window: SMALL_WINDOW, extension: true, reserveTokens: 200 },
	smallBaseline: { name: "small-baseline", window: SMALL_WINDOW, extension: false, reserveTokens: 200 },
	drop: { name: "drop", window: SMALL_WINDOW, extension: true, reserveTokens: 200, padding: 12_000 },
	gate: { name: "gate", window: GATE_WINDOW, extension: true },
	gateBaseline: { name: "gate-baseline", window: GATE_WINDOW, extension: false },
	large: { name: "large", window: LARGE_WINDOW, extension: true },
	largeBaseline: { name: "large-baseline", window: LARGE_WINDOW, extension: false },
	instructions: { name: "instructions", window: SMALL_WINDOW, extension: true, reserveTokens: 200 },
} satisfies Record<string, Scenario>;

let work: string;
const runs = {} as Record<keyof typeof SCENARIOS, Run>;

function bigFile(): string {
	const lines: string[] = [];
	for (let index = 1; index <= 600; index++) {
		lines.push(`line ${String(index).padStart(4, "0")}: the quick brown fox jumps over the lazy dog, again and again`);
	}
	return `${lines.join("\n")}\n`;
}

function readCalls(log: string): Call[] {
	const content = fs.readFileSync(path.join(log, "calls.log"), "utf-8").trim();
	return content ? content.split("\n").map((line) => JSON.parse(line) as Call) : [];
}

function readRequests(log: string): string[] {
	return fs
		.readdirSync(log)
		.filter((file) => file.startsWith("req-"))
		.sort()
		.map((file) => fs.readFileSync(path.join(log, file), "utf-8"));
}

function readSession(sessions: string): Pick<Run, "entries" | "compactions" | "usage"> {
	const entries: Entry[] = [];
	for (const file of fs.readdirSync(sessions).filter((name) => name.endsWith(".jsonl"))) {
		for (const line of fs.readFileSync(path.join(sessions, file), "utf-8").split("\n")) {
			if (line.trim()) entries.push(JSON.parse(line) as Entry);
		}
	}
	const compactions = entries.filter((entry): entry is Entry & CompactionEntry => entry.type === "compaction");
	const usage: Usage = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage) continue;
		for (const key of Object.keys(usage) as Array<keyof Usage>) {
			usage[key] += entry.message.usage[key] ?? 0;
		}
	}
	return { entries, compactions, usage };
}

function runScenario(scenario: Scenario): Run {
	const runDir = path.join(work, "runs", scenario.name);
	const log = path.join(runDir, "log");
	const sessions = path.join(runDir, "sessions");
	const project = path.join(runDir, "project");
	for (const dir of [log, sessions, path.join(project, ".pi")]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(project, "big.txt"), bigFile());
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({
			compaction: { enabled: true, keepRecentTokens: 600, ...(scenario.reserveTokens === undefined ? {} : { reserveTokens: scenario.reserveTokens }) },
		}),
	);

	const prompt = scenario.padding ? `${"x".repeat(scenario.padding)} ${PROMPT}` : PROMPT;
	execFileSync(
		PI_BIN,
		[
			...PI_ARGS,
			"-p",
			// The project settings above only load for a trusted project.
			"-a",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"-e",
			FAUX_PROVIDER,
			...(scenario.extension ? ["-e", EXTENSION] : []),
			"--provider",
			"faux",
			"--model",
			"faux-1",
			"--tools",
			"read",
			"--session-dir",
			sessions,
			"--session-id",
			scenario.name,
			prompt,
		],
		{
			cwd: project,
			encoding: "utf-8",
			timeout: 120_000,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, HARNESS_COMPACTION_LOG: log, FAUX_WINDOW: String(scenario.window) },
		},
	);

	return {
		calls: readCalls(log),
		requests: readRequests(log),
		...readSession(sessions),
	};
}

interface RpcRecord {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	data?: { summary?: string };
}

/** Drive one run through RPC mode so a command can reach the session after the agent settles. */
function runCompactWithInstructions(scenario: Scenario): Promise<Run> {
	const runDir = path.join(work, "runs", scenario.name);
	const log = path.join(runDir, "log");
	const sessions = path.join(runDir, "sessions");
	const project = path.join(runDir, "project");
	for (const dir of [log, sessions, path.join(project, ".pi")]) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(project, "big.txt"), bigFile());
	fs.writeFileSync(
		path.join(project, ".pi", "settings.json"),
		JSON.stringify({ compaction: { enabled: true, keepRecentTokens: 600, reserveTokens: scenario.reserveTokens } }),
	);

	const child = spawn(
		PI_BIN,
		[
			...PI_ARGS,
			"--mode",
			"rpc",
			"-a",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"-e",
			FAUX_PROVIDER,
			"-e",
			EXTENSION,
			"--provider",
			"faux",
			"--model",
			"faux-1",
			"--tools",
			"read",
			"--session-dir",
			sessions,
			"--session-id",
			scenario.name,
		],
		{
			cwd: project,
			env: { ...process.env, HARNESS_COMPACTION_LOG: log, FAUX_WINDOW: String(scenario.window) },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	return new Promise((resolve, reject) => {
		let buffer = "";
		let compacting = false;
		const finish = () => {
			child.kill();
			setTimeout(() => resolve({ calls: readCalls(log), requests: readRequests(log), ...readSession(sessions) }), 100);
		};
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error("rpc compact run timed out"));
		}, 60_000);
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			buffer += chunk;
			for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				const record = JSON.parse(line) as RpcRecord;
				if (record.type === "agent_settled" && !compacting) {
					compacting = true;
					child.stdin.write(`${JSON.stringify({ id: "compact-1", type: "compact", customInstructions: "focus on the file read" })}\n`);
				}
				if (record.type === "response" && record.id === "compact-1") {
					clearTimeout(timer);
					child.stdin.end();
					finish();
				}
			}
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin.write(`${JSON.stringify({ id: "prompt-1", type: "prompt", message: PROMPT })}\n`);
	});
}

const summaryCalls = (run: Run): number => run.calls.filter((call) => call.kind === "summary").length;
const requestsWithMarker = (run: Run): number =>
	run.requests.filter((request) => request.includes(MARKER_NEEDLE)).length;
const storedResultChars = (run: Run): number[] =>
	run.entries
		.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult")
		.map((entry) => (entry.message?.content ?? []).reduce((sum, block) => sum + (block.text?.length ?? 0), 0));

function facts(run: Run) {
	return {
		summaryCalls: summaryCalls(run),
		turnCalls: run.calls.filter((call) => call.kind === "turn").length,
		compactions: run.compactions.length,
		requests: run.requests.length,
		requestsWithMarker: requestsWithMarker(run),
		storedResultChars: storedResultChars(run),
		biggestRequestChars: Math.max(0, ...run.requests.map((request) => request.length)),
		cacheWrite: run.usage.cacheWrite,
		cacheRead: run.usage.cacheRead,
	};
}

before(async () => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-compaction-smoke-"));
	for (const key of Object.keys(SCENARIOS) as Array<keyof typeof SCENARIOS>) {
		if (key === "instructions") continue;
		runs[key] = runScenario(SCENARIOS[key]);
	}
	runs.instructions = await runCompactWithInstructions(SCENARIOS.instructions);
});

after(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

describe("smoke: real pi CLI, faux model", () => {
	test("the prune reaches the wire and nothing is summarized", (t) => {
		t.diagnostic(`small extension: ${JSON.stringify(facts(runs.small))}`);
		t.diagnostic(`small baseline:  ${JSON.stringify(facts(runs.smallBaseline))}`);
		assert.equal(summaryCalls(runs.small), 0);
		assert.ok(requestsWithMarker(runs.small) >= 1, "a request carried the prune marker");
		assert.deepEqual(
			storedResultChars(runs.small),
			[PRUNED_CHARS, PRUNED_CHARS, PRUNED_CHARS],
			"the append-time prune shrank every stored result",
		);
		assert.ok(
			runs.small.usage.cacheWrite < runs.smallBaseline.usage.cacheWrite,
			`pruning writes less to cache: ${runs.small.usage.cacheWrite} < ${runs.smallBaseline.usage.cacheWrite}`,
		);
	});

	test("small window without the extension asks for a summary", (t) => {
		t.diagnostic(`small baseline: ${JSON.stringify(facts(runs.smallBaseline))}`);
		assert.ok(summaryCalls(runs.smallBaseline) >= 1, "pi wrote its summary");
		assert.ok(runs.smallBaseline.compactions.length >= 1, "pi compacted");
		assert.equal(requestsWithMarker(runs.smallBaseline), 0, "pi never prunes");
		assert.deepEqual(storedResultChars(runs.smallBaseline), [BIG_FILE_BYTES, BIG_FILE_BYTES, BIG_FILE_BYTES]);
	});

	test("a history the prune cannot shrink is dropped with the note", (t) => {
		const run = runs.drop;
		t.diagnostic(`drop: ${JSON.stringify(facts(run))}`);
		assert.equal(summaryCalls(run), 0);
		assert.ok(run.compactions.length >= 1, "the padded prompt forced the drop");
		for (const entry of run.compactions) {
			assert.equal(entry.summary, CONFIG.droppedHistoryNote);
			assert.equal(entry.fromHook, true);
			assert.equal(typeof entry.firstKeptEntryId, "string");
		}
	});

	test("the gate opens at pi's default reserve and the drop is averted", (t) => {
		t.diagnostic(`gate extension: ${JSON.stringify(facts(runs.gate))}`);
		t.diagnostic(`gate baseline:  ${JSON.stringify(facts(runs.gateBaseline))}`);
		assert.equal(summaryCalls(runs.gate), 0);
		assert.ok(requestsWithMarker(runs.gate) >= 1, "a request carried the prune marker");
		assert.equal(runs.gate.compactions.length, 0, "the prune kept pi's trigger from crossing");
		assert.deepEqual(storedResultChars(runs.gate), [PRUNED_CHARS, PRUNED_CHARS, PRUNED_CHARS]);
	});

	test("the same window without the extension compacts with a summary", (t) => {
		t.diagnostic(`gate baseline: ${JSON.stringify(facts(runs.gateBaseline))}`);
		assert.ok(summaryCalls(runs.gateBaseline) >= 1, "pi wrote its summary");
		assert.ok(runs.gateBaseline.compactions.length >= 1, "pi compacted");
		assert.equal(requestsWithMarker(runs.gateBaseline), 0);
	});

	test("large window with the extension is untouched and matches pi alone", (t) => {
		t.diagnostic(`large extension: ${JSON.stringify(facts(runs.large))}`);
		t.diagnostic(`large baseline:  ${JSON.stringify(facts(runs.largeBaseline))}`);
		assert.equal(summaryCalls(runs.large), 0);
		assert.equal(runs.large.compactions.length, 0, "below the gate nothing compacts");
		assert.equal(requestsWithMarker(runs.large), 0, "below the gate nothing is pruned");
		assert.deepEqual(runs.large.requests, runs.largeBaseline.requests, "request bytes match pi alone");
		// The two sessions register different commands, so their system prompts differ by a few
		// tokens and the faux provider's cache accounting drifts with them.
		for (const key of ["cacheRead", "cacheWrite"] as const) {
			assert.ok(
				Math.abs(runs.large.usage[key] - runs.largeBaseline.usage[key]) <= 100,
				`${key} matches pi alone within drift: ${runs.large.usage[key]} vs ${runs.largeBaseline.usage[key]}`,
			);
		}
	});


	test("custom instructions still fall back to pi's summarizer", (t) => {
		const run = runs.instructions;
		t.diagnostic(`instructions: ${JSON.stringify(facts(run))}`);
		const manual = run.compactions.filter((entry) => entry.fromHook === false);
		assert.equal(manual.length, 1, "the manual compaction is pi's, not the hook's");
		assert.ok(summaryCalls(run) >= 1, "pi's summarizer ran");
		assert.match(String(manual[0]?.summary), /\[faux summary\]/);
		assert.notEqual(manual[0]?.summary, CONFIG.droppedHistoryNote);
		assert.ok(
			run.compactions.some((entry) => entry.fromHook === true && entry.summary === CONFIG.droppedHistoryNote),
			"the threshold compaction before it used the note",
		);
	});

	test("every tool call keeps its result after the prunes and drops", () => {
		for (const run of [runs.small, runs.drop]) {
			const calls = new Set<string>();
			const results = new Set<string>();
			for (const entry of run.entries) {
				if (entry.type !== "message" || !entry.message) continue;
				if (entry.message.role === "assistant") {
					for (const block of entry.message.content ?? []) {
						if (block.type === "toolCall" && block.id) calls.add(block.id);
					}
				}
				if (entry.message.role === "toolResult" && entry.message.toolCallId) {
					results.add(entry.message.toolCallId);
				}
			}
			assert.ok(calls.size > 0, `${run.entries.length} entries made tool calls`);
			for (const id of calls) assert.ok(results.has(id), `tool call ${id} kept its result`);
		}
	});
});
