import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const LARGE_WINDOW = 900_000;
const PROMPT = "Read big.txt three times. Then say DONE.";
const BIG_FILE_BYTES = 43_200;
const MARKER_NEEDLE = CONFIG.marker.trim();

interface Call {
	n: number;
	kind: "summary" | "turn";
}

interface CompactionEntry {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	fromHook?: boolean;
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
	message?: {
		role?: string;
		content?: Array<{ type?: string; id?: string }>;
		toolCallId?: string;
		usage?: Partial<Usage>;
	};
}

interface Run {
	calls: Call[];
	requests: string[];
	compactions: CompactionEntry[];
	usage: Usage;
	entries: Entry[];
}

let work: string;
let repo: string;
let small: Run;
let baseline: Run;
let large: Run;
let largeBaseline: Run;

function bigFile(): string {
	const lines: string[] = [];
	for (let index = 1; index <= 600; index++) {
		lines.push(`line ${String(index).padStart(4, "0")}: the quick brown fox jumps over the lazy dog, again and again`);
	}
	return `${lines.join("\n")}\n`;
}

function readCalls(log: string): Call[] {
	const text = fs.readFileSync(path.join(log, "calls.log"), "utf-8").trim();
	return text ? text.split("\n").map((line) => JSON.parse(line) as Call) : [];
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

function runScenario(name: string, options: { window: number; extension: boolean }): Run {
	const runDir = path.join(work, "runs", name);
	const log = path.join(runDir, "log");
	const sessions = path.join(runDir, "sessions");
	fs.mkdirSync(log, { recursive: true });
	fs.mkdirSync(sessions, { recursive: true });

	execFileSync(
		PI_BIN,
		[
			...PI_ARGS,
			"-p",
			"--no-extensions",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"-e",
			FAUX_PROVIDER,
			...(options.extension ? ["-e", EXTENSION] : []),
			"--provider",
			"faux",
			"--model",
			"faux-1",
			"--tools",
			"read",
			"--session-dir",
			sessions,
			"--session-id",
			name,
			PROMPT,
		],
		{
			cwd: repo,
			encoding: "utf-8",
			timeout: 120_000,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, HARNESS_COMPACTION_LOG: log, FAUX_WINDOW: String(options.window) },
		},
	);

	return {
		calls: readCalls(log),
		requests: readRequests(log),
		...readSession(sessions),
	};
}

const summaryCalls = (run: Run): number => run.calls.filter((call) => call.kind === "summary").length;
const requestsWithMarker = (run: Run): number =>
	run.requests.filter((request) => request.includes(MARKER_NEEDLE)).length;

function facts(run: Run) {
	return {
		summaryCalls: summaryCalls(run),
		turnCalls: run.calls.filter((call) => call.kind === "turn").length,
		compactions: run.compactions.length,
		requests: run.requests.length,
		requestsWithMarker: requestsWithMarker(run),
		biggestRequestChars: Math.max(0, ...run.requests.map((request) => request.length)),
		cacheWrite: run.usage.cacheWrite,
		cacheRead: run.usage.cacheRead,
	};
}

before(() => {
	work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-compaction-smoke-"));
	repo = path.join(work, "project");
	fs.mkdirSync(path.join(repo, ".pi"), { recursive: true });
	fs.writeFileSync(path.join(repo, "big.txt"), bigFile());
	fs.writeFileSync(
		path.join(repo, ".pi", "settings.json"),
		JSON.stringify({ compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 600 } }, null, 2),
	);
	assert.equal(fs.statSync(path.join(repo, "big.txt")).size, BIG_FILE_BYTES);

	small = runScenario("small-extension", { window: SMALL_WINDOW, extension: true });
	baseline = runScenario("small-baseline", { window: SMALL_WINDOW, extension: false });
	large = runScenario("large-extension", { window: LARGE_WINDOW, extension: true });
	largeBaseline = runScenario("large-baseline", { window: LARGE_WINDOW, extension: false });
});

after(() => {
	fs.rmSync(work, { recursive: true, force: true });
});

describe("smoke: real pi CLI, faux model", () => {
	test("small window with the extension never asks for a summary", (t) => {
		t.diagnostic(`small extension: ${JSON.stringify(facts(small))}`);
		t.diagnostic(`small baseline:  ${JSON.stringify(facts(baseline))}`);
		assert.equal(summaryCalls(small), 0);
		assert.ok(small.compactions.length >= 1, "the threshold compaction fired");
		assert.ok(requestsWithMarker(small) >= 1, "a request carried the prune marker");
		for (const entry of small.compactions) {
			assert.equal(entry.summary, CONFIG.droppedHistoryNote);
			assert.equal(entry.fromHook, true);
			assert.equal(typeof entry.firstKeptEntryId, "string");
		}
		assert.ok(
			small.usage.cacheWrite < baseline.usage.cacheWrite,
			`pruning writes less to cache: ${small.usage.cacheWrite} < ${baseline.usage.cacheWrite}`,
		);
		assert.ok(
			small.usage.cacheRead > baseline.usage.cacheRead,
			`pruning reads more from cache: ${small.usage.cacheRead} > ${baseline.usage.cacheRead}`,
		);
	});

	test("small window without the extension asks for a summary", (t) => {
		t.diagnostic(`small baseline: ${JSON.stringify(facts(baseline))}`);
		assert.ok(summaryCalls(baseline) >= 1, "pi wrote its summary");
		assert.ok(baseline.compactions.length >= 1, "pi compacted");
		assert.equal(requestsWithMarker(baseline), 0, "pi never prunes");
	});

	test("large window with the extension is untouched and matches pi alone", (t) => {
		t.diagnostic(`large extension: ${JSON.stringify(facts(large))}`);
		t.diagnostic(`large baseline:  ${JSON.stringify(facts(largeBaseline))}`);
		assert.equal(summaryCalls(large), 0);
		assert.equal(large.compactions.length, 0, "below the gate nothing compacts");
		assert.equal(requestsWithMarker(large), 0, "below the gate nothing is pruned");
		assert.deepEqual(large.requests, largeBaseline.requests, "request bytes match pi alone");
		assert.deepEqual(large.usage, largeBaseline.usage, "cache accounting matches pi alone");
	});

	test("every tool call keeps its result after the prunes and drops", () => {
		const calls = new Set<string>();
		const results = new Set<string>();
		for (const entry of small.entries) {
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
		assert.ok(calls.size > 0, "the run made tool calls");
		for (const id of calls) assert.ok(results.has(id), `tool call ${id} kept its result`);
	});
});
