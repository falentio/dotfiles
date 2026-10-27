import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	SessionManager,
	type CompactionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { planPrecompute } from "../boundary.ts";
import {
	FAUX_API,
	FAUX_MODEL,
	FAUX_PROVIDER,
	emptyVerifyLog,
	SUMMARY_MARKER,
	VERIFY_LOG_KEY,
	type VerifyLog,
	type VerifyRequest,
} from "../mock-provider.ts";

const HERE = import.meta.dir;
const SOURCE = join(HERE, "..");
const MOCK_MODEL_REF = `${FAUX_PROVIDER}/${FAUX_MODEL}`;

const mockModel = {
	id: FAUX_MODEL,
	name: "Mock model",
	api: FAUX_API,
	provider: FAUX_PROVIDER,
	baseUrl: "http://127.0.0.1/mock",
	reasoning: false,
	input: ["text"] as Array<"text" | "image">,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

interface Scenario {
	enabled?: boolean;
	compactWhenReady?: boolean;
	keepRecentTokens?: number;
	tailMin?: number;
}

interface OpenSession {
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	log: VerifyLog;
	close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function openSession(scenario: Scenario = {}): Promise<OpenSession> {
	const cwd = await mkdtemp(join(tmpdir(), "bgc-project-"));
	const agentDir = await mkdtemp(join(tmpdir(), "bgc-agent-"));
	const extensionDir = join(agentDir, "extensions", "background-compaction");
	await mkdir(extensionDir, { recursive: true });

	for (const file of ["index.ts", "config.ts", "boundary.ts", "state.ts", "package.json"]) {
		await writeFile(join(extensionDir, file), await readFile(join(SOURCE, file), "utf8"));
	}
	await writeFile(join(agentDir, "extensions", "mock-provider.ts"), await readFile(join(SOURCE, "mock-provider.ts"), "utf8"));

	const enabled = scenario.enabled ?? true;
	const compactWhenReady = scenario.compactWhenReady ?? true;
	const keepRecentTokens = scenario.keepRecentTokens ?? 20_000;
	const tailMin = scenario.tailMin ?? 30_000;
	const config = (await readFile(join(SOURCE, "config.ts"), "utf8"))
		.replace("enabled: true,", `enabled: ${enabled},`)
		.replace("compactWhenReady: true,", `compactWhenReady: ${compactWhenReady},`)
		.replace("keepRecentTokens: 20_000,", `keepRecentTokens: ${keepRecentTokens},`)
		.replace("tailMin: 30_000,", `tailMin: ${tailMin},`);
	await writeFile(join(extensionDir, "config.ts"), config);

	const log = emptyVerifyLog();
	(globalThis as Record<string, unknown>)[VERIFY_LOG_KEY] = log;

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		model: mockModel,
		thinkingLevel: "off",
		tools: ["bloat"],
	});

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "compaction_start") {
			log.events.push({ kind: "compaction_start", seq: log.seq++, reason: event.reason });
		}
		if (event.type === "compaction_end") {
			log.events.push({ kind: "compaction_end", seq: log.seq++, reason: event.reason });
		}
	});

	const close = async () => {
		unsubscribe();
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
		await rm(agentDir, { recursive: true, force: true });
	};
	cleanups.push(close);
	return { session, log, close };
}

function markPrompt(log: VerifyLog, text: string): void {
	log.events.push({ kind: "prompt", seq: log.seq++, text });
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 8_000): Promise<T> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = read();
		if (value !== undefined) return value;
		await sleep(10);
	}
	throw new Error("timed out waiting for the session");
}

function summaryRequests(log: VerifyLog): VerifyRequest[] {
	return log.requests.filter((request) => request.summary);
}

function waitForSummaryEnd(request: VerifyRequest): Promise<VerifyRequest> {
	return waitUntil(() => (request.endedSeq === undefined ? undefined : request), 5_000);
}

function lastCompaction(session: OpenSession["session"]): CompactionEntry | undefined {
	const entries = session.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "compaction") return entry;
	}
	return undefined;
}

function compactionStart(log: VerifyLog): { seq: number; reason?: string } | undefined {
	return log.events.find((event) => event.kind === "compaction_start");
}

async function driveToSummary(open: OpenSession, maxTurns = 6): Promise<VerifyRequest> {
	for (let turn = 1; turn <= maxTurns; turn++) {
		markPrompt(open.log, `turn ${turn}`);
		await open.session.prompt(`turn ${turn}`);
		await open.session.waitForIdle();
		await sleep(30);
		const summary = summaryRequests(open.log)[0];
		if (summary) return summary;
	}
	throw new Error("the summary never started");
}

async function driveToCompaction(open: OpenSession, maxTurns = 8): Promise<CompactionEntry> {
	for (let turn = 1; turn <= maxTurns; turn++) {
		if (lastCompaction(open.session)) return lastCompaction(open.session)!;
		markPrompt(open.log, `turn ${turn}`);
		await open.session.prompt(`turn ${turn}`);
		await open.session.waitForIdle();
		const entry = await waitUntil(() => lastCompaction(open.session), 500).catch(() => undefined);
		if (entry) return entry;
	}
	throw new Error("the session never compacted");
}

async function driveWithMediumTurns(open: OpenSession, maxTurns = 4): Promise<CompactionEntry> {
	for (let turn = 1; turn <= maxTurns; turn++) {
		markPrompt(open.log, `medium ${turn}`);
		await open.session.prompt(`medium ${turn}`);
		await open.session.waitForIdle();
		const entry = await waitUntil(() => lastCompaction(open.session), 500).catch(() => undefined);
		if (entry) return entry;
	}
	throw new Error("the session never compacted");
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block !== "object" || block === null) return "";
			const text = (block as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

describe("one real session", () => {
	it(
		"summarizes once, then compacts before the next prompt",
		async () => {
			const open = await openSession();
			const request = await driveToSummary(open);
			const plan = planPrecompute(open.session.sessionManager.getBranch(), 20_000, MOCK_MODEL_REF);
			expect(plan).toBeDefined();

			const start = await waitUntil(() => compactionStart(open.log), 5_000);
			const entry = await waitUntil(() => lastCompaction(open.session), 5_000);

			expect(summaryRequests(open.log).length).toBe(1);
			expect(request.endedSeq).toBeDefined();
			expect(request.endedSeq!).toBeLessThan(start.seq);
			expect(entry.fromHook).toBe(true);
			expect(entry.firstKeptEntryId).toBe(plan!.keepEntryId);
			expect(open.log.maxSummaryInFlight).toBe(1);

			const lastPrompt = [...open.log.events].reverse().find((event) => event.kind === "prompt");
			expect(lastPrompt?.seq).toBeLessThan(start.seq);

			const keptPrompt = open.log.requests.filter((item) => !item.summary).at(-1)?.lastUserText;
			markPrompt(open.log, "after compaction simple");
			await open.session.prompt("after compaction simple");
			await open.session.waitForIdle();
			const next = await waitUntil(
				() => open.log.requests.find((item) => !item.summary && item.lastUserText.includes("after compaction simple")),
				2_000,
			);
			expect(next.texts.some((text) => text.includes(SUMMARY_MARKER))).toBe(true);
			expect(next.texts.some((text) => text.includes(`done ${keptPrompt}`))).toBe(true);
		},
		20_000,
	);

	it(
		"keeps the summary ready without compacting when compactWhenReady is false",
		async () => {
			const open = await openSession({ compactWhenReady: false });
			const request = await driveToSummary(open);
			const plan = planPrecompute(open.session.sessionManager.getBranch(), 20_000, MOCK_MODEL_REF);
			expect(plan).toBeDefined();
			expect(lastCompaction(open.session)).toBeUndefined();
			await waitForSummaryEnd(request);

			const entry = await driveWithMediumTurns(open, 4);
			expect(entry.fromHook).toBe(true);
			expect(entry.firstKeptEntryId).toBe(plan!.keepEntryId);
			expect(summaryRequests(open.log).length).toBe(1);
		},
		20_000,
	);

	it(
		"lets the threshold compaction summarize when the extension is disabled",
		async () => {
			const open = await openSession({ enabled: false });
			const entry = await driveToCompaction(open, 8);
			expect(entry.fromHook).not.toBe(true);

			const start = compactionStart(open.log);
			expect(start).toBeDefined();
			const summary = summaryRequests(open.log)[0];
			expect(summary).toBeDefined();
			expect(summary!.seq).toBeGreaterThan(start!.seq);
		},
		20_000,
	);

	it(
		"does not abort a prompt queued while the summary runs",
		async () => {
			const open = await openSession();
			await driveToSummary(open);
			const plan = planPrecompute(open.session.sessionManager.getBranch(), 20_000, MOCK_MODEL_REF);
			expect(plan).toBeDefined();

			await open.session.prompt("slow simple turn");
			await open.session.waitForIdle();
			const entry = await waitUntil(() => lastCompaction(open.session), 5_000);
			expect(entry.fromHook).toBe(true);
			expect(entry.firstKeptEntryId).toBe(plan!.keepEntryId);

			const branch = open.session.sessionManager.getBranch();
			const keepIndex = branch.findIndex((item) => item.id === entry.firstKeptEntryId);
			expect(keepIndex).toBeGreaterThanOrEqual(0);
			const kept = branch.slice(keepIndex) as SessionEntry[];
			expect(
				kept.some(
					(item) =>
						item.type === "message" &&
						item.message.role === "user" &&
						contentText(item.message.content).includes("slow simple turn"),
				),
			).toBe(true);
		},
		20_000,
	);

	it(
		"drops a summary whose tail grew past the limit and skips compaction",
		async () => {
			const open = await openSession({ keepRecentTokens: 1_000, tailMin: 1_000 });
			await driveToSummary(open);
			const plan = planPrecompute(open.session.sessionManager.getBranch(), 1_000, MOCK_MODEL_REF);
			expect(plan).toBeDefined();

			markPrompt(open.log, "medium turn");
			await open.session.prompt("medium turn");
			await open.session.waitForIdle();
			await sleep(700);

			expect(lastCompaction(open.session)).toBeUndefined();
			expect(compactionStart(open.log)).toBeUndefined();
			expect(summaryRequests(open.log).length).toBe(1);
		},
		20_000,
	);
});
