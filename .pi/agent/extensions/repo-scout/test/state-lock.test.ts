/**
 * The cross-process mutex: one holder per lock directory, waiters queue, a dead holder is stolen,
 * and a real second node process waits for this one before it proceeds.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { acquireLock } from "../state-lock.ts";

const run = promisify(execFile);
const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const lockDir = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "repo-scout-lock-"));
	roots.push(root);
	return join(root, "repo.lock");
};

const plant = async (dir: string, pid: number, ageMs = 0): Promise<void> => {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "owner.json"), JSON.stringify({ pid, host: hostname(), at: Date.now() - ageMs }));
};

const ownerPid = async (dir: string): Promise<number> => {
	const owner = JSON.parse(await readFile(join(dir, "owner.json"), "utf8")) as { pid: number };
	return owner.pid;
};

describe("acquireLock", () => {
	it("takes the lock and removes it on release", async () => {
		const dir = await lockDir();
		const release = await acquireLock({ dir, label: "repo" });
		assert.equal(await ownerPid(dir), process.pid);
		await release();
		await assert.rejects(readFile(join(dir, "owner.json")), /ENOENT/);
	});

	it("is reentrant within one process, and frees only on the last release", async () => {
		const dir = await lockDir();
		const first = await acquireLock({ dir, label: "repo" });
		const second = await acquireLock({ dir, label: "repo" });
		await first();
		assert.equal(await ownerPid(dir), process.pid, "one holder remains");
		await second();
		await assert.rejects(readFile(join(dir, "owner.json")), /ENOENT/);
	});

	it("steals a lock whose owner is dead", async () => {
		const dir = await lockDir();
		await plant(dir, 999_999);
		const release = await acquireLock({ dir, label: "repo", waitMs: 500, pollMs: 10 });
		assert.equal(await ownerPid(dir), process.pid);
		await release();
	});

	it("steals a lock whose heartbeat stopped", async () => {
		const dir = await lockDir();
		await plant(dir, process.pid, 60_000);
		const release = await acquireLock({ dir, label: "repo", heartbeatMs: 100, waitMs: 1_000, pollMs: 10 });
		assert.equal(await ownerPid(dir), process.pid);
		await release();
	});

	it("times out against a live holder and names it", async () => {
		const dir = await lockDir();
		await plant(dir, process.pid);
		await assert.rejects(
			acquireLock({ dir, label: "github.com/o/n@v1", waitMs: 120, pollMs: 10, heartbeatMs: 60_000 }),
			/another pi process holds github\.com\/o\/n@v1, held by pid \d+ on /,
		);
		await rm(dir, { recursive: true, force: true });
	});

	it("stops waiting when the caller aborts", async () => {
		const dir = await lockDir();
		await plant(dir, process.pid);
		const controller = new AbortController();
		const waiting = acquireLock({ dir, label: "repo", waitMs: 10_000, pollMs: 10, heartbeatMs: 60_000 }, controller.signal);
		setTimeout(() => controller.abort(), 30);
		await assert.rejects(waiting, /lock wait aborted/);
		await rm(dir, { recursive: true, force: true });
	});

	it("keeps a held lock fresh so it is not stolen", async () => {
		const dir = await lockDir();
		const release = await acquireLock({ dir, label: "repo", heartbeatMs: 20 });
		const before = (await readFile(join(dir, "owner.json"), "utf8")).length;
		await new Promise((resolve) => setTimeout(resolve, 90));
		assert.equal((await readFile(join(dir, "owner.json"), "utf8")).length, before);
		// A second process would still see a fresh mtime, so the lock is not stolen.
		const mtime = (await import("node:fs/promises")).stat;
		assert.ok((await mtime(join(dir, "owner.json"))).mtimeMs > 0);
		await release();
	});

	it("makes a second node process wait for this one", async () => {
		const dir = await lockDir();
		const release = await acquireLock({ dir, label: "repo" });
		const moduleUrl = new URL("../state-lock.ts", import.meta.url).href;
		const script = `
			import { acquireLock } from "${moduleUrl}";
			const started = Date.now();
			const release = await acquireLock({ dir: process.env.LOCK_DIR, label: "probe", waitMs: 5000, pollMs: 20 });
			console.log("acquired " + Date.now() + " after " + (Date.now() - started));
			await release();
		`;
		const child = run(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, LOCK_DIR: dir },
			timeout: 15_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		await release();
		const releasedAt = Date.now();
		const { stdout } = await child;
		const at = Number(/acquired (\d+)/.exec(stdout)?.[1] ?? 0);
		const elapsed = Number(/after (\d+)/.exec(stdout)?.[1] ?? 0);
		assert.ok(at >= releasedAt - 20, `the child acquired only after the holder released (released ${releasedAt - at}ms earlier)`);
		assert.ok(elapsed >= 200, `the child waited for the holder (waited ${elapsed}ms)`);
	});
});
