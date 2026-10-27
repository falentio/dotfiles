import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const moduleUrl = (name: string): string => new URL("../" + name, import.meta.url).href;

const childScript = (): string => `
	import { existsSync, mkdirSync, writeFileSync } from "node:fs";
	import { join } from "node:path";
	import { ScoutRegistry, conversationKey } from "${moduleUrl("scout-registry.ts")}";
	import { acquireLock } from "${moduleUrl("state-lock.ts")}";
	import { readSessionIndex, writeSessionIndex } from "${moduleUrl("session-index.ts")}";

	const root = process.env.ROOT;
	const key = "github.com/example/cross";
	const modelId = process.env.MODEL;
	const sessionFile = join(root, "session.jsonl");
	const indexDir = join(root, "keys");
	mkdirSync(root, { recursive: true });
	const started = Date.now();
	let acquired = 0;
	let releases = 0;

	const registry = new ScoutRegistry({
		acquire: async (request, signal) => {
			const release = await acquireLock(
				{ dir: join(root, "repo.lock"), label: "the cross-process repo", waitMs: 10_000, pollMs: 25 },
				signal,
			);
			acquired = Date.now();
			return async () => {
				releases += 1;
				await release();
			};
		},
		checkout: async () => ({ dir: join(root, "tree"), display: key }),
		refresh: async () => {},
		adapter: {
			async open(_repo, _dir, file) {
				const fresh = !file || !existsSync(file);
				writeFileSync(sessionFile, "transcript\\n");
				return {
					ask: async (question) => {
						await new Promise((resolve) => setTimeout(resolve, 300));
						return "answer to " + question + " on " + modelId;
					},
					sessionFile: () => sessionFile,
					fresh: () => fresh,
					dispose: () => {},
				};
			},
		},
		sessionFileFor: (k) => readSessionIndex(indexDir, k),
		newSessionFile: () => sessionFile,
		rememberSession: (k, f) => writeSessionIndex(indexDir, k, f),
		idleMs: 600_000,
		sweepMs: 600_000,
		turnMs: 60_000,
		now: Date.now,
	});

	const result = await registry.run({
		repo: { key, source: "https://" + key, display: key, kind: "remote", slug: "cross" },
		ref: "v1",
		model: { provider: "p", id: modelId },
		thinkingLevel: "medium",
		question: process.env.QUESTION,
	});
	// Keep the lock past the answer, the way a live session does, then release it on shutdown.
	await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS)));
	await registry.shutdown();
	console.log(JSON.stringify({
		started,
		acquired,
		releasedAt: Date.now(),
		fresh: result.fresh,
		file: result.sessionFile,
		releases,
		report: result.report,
	}));
`;

const spawn = async (root: string, env: Record<string, string>): Promise<Record<string, unknown>> => {
	const { stdout } = await run(process.execPath, ["--input-type=module", "-e", childScript()], {
		env: { ...process.env, ROOT: root, ...env },
		timeout: 30_000,
	});
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
};

describe("two processes on one repo and ref", () => {
	it("makes the second wait, then continue the first transcript on another model", async () => {
		const root = await mkdtemp(join(tmpdir(), "repo-scout-cross-"));
		roots.push(root);

		const first = spawn(root, { MODEL: "m1", QUESTION: "first", HOLD_MS: "700" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		const second = spawn(root, { MODEL: "m2", QUESTION: "second", HOLD_MS: "0" });

		const [a, b] = await Promise.all([first, second]);
		assert.ok(Number(b.started) < Number(a.releasedAt), "the two processes overlapped");
		assert.ok(
			Number(b.acquired) >= Number(a.releasedAt) - 30,
			"the second acquired only after the first released (early by " +
				(Number(a.releasedAt) - Number(b.acquired)) +
				"ms)",
		);
		assert.ok(Number(b.acquired) - Number(b.started) >= 500, "the second waited on the lock");
		assert.equal(b.file, a.file, "both read one transcript");
		assert.equal(b.fresh, false, "the second turn continued the first transcript");
		assert.match(String(b.report), /answer to second on m2/);
		assert.equal(a.releases, 1, "the first process released the lock");
	});
});
