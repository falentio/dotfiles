/**
 * Smoke test: drive the REAL pi binary against the LIVE installed extension (no -e flag, so this
 * also proves discovery works) and assert on the session transcript.
 *
 * Slower than the unit tests (each pi run is a real model call). Run explicitly:
 *   node --test ~/.pi/agent/extensions/nested-agents/smoke.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const PI = process.env.PI_BIN ?? "pi";

let repo: string;
let sessions: string;

function write(rel: string, body: string): void {
	const abs = path.join(repo, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
}

/** Run pi in print mode. Returns combined output; the transcript is written under `sessions`. */
function runPi(sessionId: string, prompt: string, extraArgs: string[] = []): string {
	return execFileSync(
		PI,
		[
			"-p",
			"--no-mcp",
			"--no-skills",
			"--no-context-files",
			"--session-dir", sessions,
			"--session-id", sessionId,
			...extraArgs,
			prompt,
		],
		{ cwd: repo, encoding: "utf-8", timeout: 240_000, stdio: ["ignore", "pipe", "pipe"] },
	);
}

/** All markers recorded in the session transcript for a session id. */
function markers(sessionId: string): Array<{ path: string; hash: string }> {
	const dir = sessions;
	const files = fs.readdirSync(dir).filter((f) => f.includes(sessionId));
	const out: Array<{ path: string; hash: string }> = [];
	for (const file of files) {
		const text = fs.readFileSync(path.join(dir, file), "utf-8");
		for (const line of text.split("\n")) {
			if (!line.includes("nested-agents-injected")) continue;
			try {
				const entry = JSON.parse(line);
				if (entry?.customType === "nested-agents-injected" && entry.data?.path) {
					out.push({ path: entry.data.path, hash: entry.data.hash });
				}
			} catch {
				// partial line
			}
		}
	}
	return out;
}

/** Count of injected project_instructions blocks in a transcript. */
function injectedBlocks(sessionId: string): number {
	const files = fs.readdirSync(sessions).filter((f) => f.includes(sessionId));
	let n = 0;
	for (const file of files) {
		const text = fs.readFileSync(path.join(sessions, file), "utf-8");
		n += (text.match(/project_instructions path=/g) ?? []).length;
	}
	return n;
}

before(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "nested-agents-smoke-"));
	sessions = fs.mkdtempSync(path.join(os.tmpdir(), "nested-agents-smoke-sessions-"));
	fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
	write("AGENTS.md", "# Root rules\n\nRoot-only rule text.\n");
	write("packages/AGENTS.md", "# Packages rules\n\nPACKAGES-ESM-ONLY.\n");
	write("packages/api/AGENTS.md", "# API rules\n\nAPI-USE-EFFECT-NOT-ASYNC.\n");
	write("packages/api/handler.ts", "export const handler = () => Effect.gen(function* () { return 1; });\n");
	write("src/thing.ts", "export const thing = 1;\n");
});

after(() => {
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(sessions, { recursive: true, force: true });
});

describe("smoke: live extension against real pi", () => {
	test("loads by discovery and injects the governing chain on read", () => {
		const output = runPi("smoke1", "Read packages/api/handler.ts. Then say DONE.");
		const marks = markers("smoke1");

		assert.equal(marks.length, 2, "two files delivered (packages + packages/api)");
		assert.ok(marks.some((m) => m.path.endsWith("packages/AGENTS.md")));
		assert.ok(marks.some((m) => m.path.endsWith("packages/api/AGENTS.md")));
		assert.ok(!marks.some((m) => m.path === path.join(repo, "AGENTS.md")), "root file never injected");
		assert.ok(output.length > 0, "pi produced output");
	});

	test("a resumed session does not re-inject unchanged instructions", () => {
		runPi("smoke2", "Read packages/api/handler.ts. Then say DONE.");
		const afterFirst = markers("smoke2").length;
		const blocksFirst = injectedBlocks("smoke2");

		runPi("smoke2", "Read packages/api/handler.ts again. Then say DONE.");
		const afterSecond = markers("smoke2").length;
		const blocksSecond = injectedBlocks("smoke2");

		assert.equal(afterSecond, afterFirst, "no new markers on resume");
		assert.equal(blocksSecond, blocksFirst, "no new injected blocks on resume");
	});

	test("editing a rule file re-injects only that file", () => {
		runPi("smoke3", "Read packages/api/handler.ts. Then say DONE.");
		const before = markers("smoke3").length;

		write("packages/api/AGENTS.md", "# API rules\n\nAPI-USE-EFFECT-NOT-ASYNC.\nAPI-NAMED-EXPORTS-ONLY.\n");
		runPi("smoke3", "Read packages/api/handler.ts again. Then say DONE.");
		const marks = markers("smoke3");

		assert.equal(marks.length, before + 1, "exactly one new marker for the changed file");
		const apiMarks = marks.filter((m) => m.path.endsWith("packages/api/AGENTS.md"));
		assert.equal(apiMarks.length, 2, "the changed file has two records (old + new hash)");
		assert.notEqual(apiMarks[0].hash, apiMarks[1].hash, "hash changed");
	});

	test("a file with no nested context does not inject", () => {
		runPi("smoke4", "Read src/thing.ts. Then say DONE.");
		assert.equal(markers("smoke4").length, 0, "nothing below cwd governs src/thing.ts");
	});

	test("editing WITHOUT reading first still injects (regression)", () => {
		// Before the fix this injected nothing: the edit tool reads through its own fs call, not
		// through the read tool, so excluding edit meant an edit-only model saw no context.
		write("packages/api/handler.ts", "export const handler = () => Effect.gen(function* () { return 1; });\n");
		runPi(
			"smoke5",
			"Use the edit tool on packages/api/handler.ts to replace the exact string \`return 1\` with \`return 5\`. Do not read the file first. Then say DONE.",
			["--tools", "edit"],
		);
		const marks = markers("smoke5");
		assert.equal(marks.length, 2, "edit injected the governing chain");
		assert.ok(marks.some((m) => m.path.endsWith("packages/api/AGENTS.md")));
		assert.equal(
			fs.readFileSync(path.join(repo, "packages/api/handler.ts"), "utf-8").includes("return 5"),
			true,
			"the edit actually happened",
		);
	});
	test("the same file is never injected twice across a resume in a new process", () => {
		// The strongest form of the guarantee: three separate pi processes on one session, reading the
		// same file each time. Only the first may inject.
		runPi("smoke6", "Read packages/api/handler.ts. Then say DONE.");
		const after1 = markers("smoke6").length;
		assert.ok(after1 > 0, "first process injected");

		runPi("smoke6", "Read packages/api/handler.ts again. Then say DONE.");
		runPi("smoke6", "Read packages/api/handler.ts once more. Then say DONE.");
		assert.equal(markers("smoke6").length, after1, "no new markers in processes 2 and 3");
		assert.equal(injectedBlocks("smoke6"), after1, "no new blocks in processes 2 and 3");
	});

	test("a symlinked path to the same file does not inject twice", () => {
		// Same file reachable two ways: the real path and a symlinked directory.
		write("linked-real/AGENTS.md", "# Linked rules\n\nLINKED-RULE-TEXT.\n");
		write("linked-real/file.ts", "export const l = 1;\n");
		fs.mkdirSync(path.join(repo, "linked-alias"), { recursive: true });
		try {
			fs.symlinkSync(path.join(repo, "linked-real/AGENTS.md"), path.join(repo, "linked-alias/AGENTS.md"));
		} catch {
			return; // symlinks unavailable: skip
		}
		write("linked-alias/other.ts", "export const o = 1;\n");

		runPi("smoke7", "Read linked-real/file.ts then read linked-alias/other.ts. Then say DONE.");
		const marks = markers("smoke7");
		assert.equal(marks.length, 1, "the same file via two paths produced one marker");
	});
	test("one batch with a shared-identity chain injects the file once", () => {
		// Real-pi regression: a parent and child directory linking to the same file must yield one
		// block, not two.
		const shared = path.join(repo, "batch-real/shared.md");
		fs.mkdirSync(path.dirname(shared), { recursive: true });
		fs.writeFileSync(shared, "SHARED BATCH RULES");
		fs.mkdirSync(path.join(repo, "batch-real/pkg/sub"), { recursive: true });
		try {
			fs.symlinkSync(shared, path.join(repo, "batch-real/pkg/AGENTS.md"));
			fs.symlinkSync(shared, path.join(repo, "batch-real/pkg/sub/AGENTS.md"));
		} catch {
			return; // symlinks unavailable: skip
		}
		fs.writeFileSync(path.join(repo, "batch-real/pkg/sub/file.ts"), "export const x = 1;");

		runPi("smoke8", "Read batch-real/pkg/sub/file.ts. Then say DONE.");
		assert.equal(markers("smoke8").length, 1, "one marker for one file reached two ways");
	});
});
