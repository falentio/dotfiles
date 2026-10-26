/**
 * The tools over real inputs: repo identification (no network), package_repo's validation and
 * rendering (fake resolver), and the scratch checkout (a real local git repo).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ensureCheckout, headSha, originOf } from "../checkout.ts";
import { homedir } from "node:os";
import { identifyRepo, runPackageRepo } from "../tools.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeRepo = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "repo-scout-test-"));
	git(root, "init", "--quiet", "--initial-branch", "main");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	await writeFile(join(root, "README.md"), "hello\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "first");
	return root;
};

const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("identifyRepo", () => {
	it("finds a local checkout and keys it by origin", async () => {
		const root = await makeRepo();
		roots.push(root);
		git(root, "remote", "add", "origin", "git@github.com:colinhacks/zod.git");
		const identity = await identifyRepo(root, homedir());
		assert.equal(identity.key, "github.com/colinhacks/zod");
		assert.equal(identity.source, root);
	});

	// A relative path is resolved against cwd by identifyRepo; the local checkout it needs is
	// the one makeRepo builds, so the absolute case above covers the same code path.
});

describe("runPackageRepo", () => {
	it("renders stated repositories with provenance", async () => {
		const { text, data } = await runPackageRepo({ package: "zod" }, async (input) => ({
			package: input.package,
			registry: "npm",
			version: "4.0.7",
			repos: [{ url: "https://github.com/colinhacks/zod", kind: "repository", source: "manifest", confidence: "stated" }],
			warnings: [],
		}));
		assert.match(text, /^package  zod$/m);
		assert.match(text, /^registry npm@4\.0\.7$/m);
		assert.match(text, /github\.com\/colinhacks\/zod  \(repository, manifest, stated\)/);
		assert.equal(data.repos.length, 1);
	});

	it("says none when nothing resolved, and keeps the warnings", async () => {
		const { text } = await runPackageRepo({ package: "ghost" }, async () => ({
			package: "ghost",
			registry: "npm",
			repos: [],
			warnings: ["no repository found"],
		}));
		assert.match(text, /repos    none/);
		assert.match(text, /warning  no repository found/);
	});

	it("rejects a registry it cannot read, and an empty name", async () => {
		await assert.rejects(runPackageRepo({ package: "x", registry: "maven" as never }), /unknown registry: maven/);
		await assert.rejects(runPackageRepo({ package: "  " }), /package is empty/);
	});
});

describe("ensureCheckout", () => {
	it("clones a local repo once and reuses the clone", async () => {
		const root = await makeRepo();
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(root, scratch);
		const identity = { key: "local:" + root, source: root, display: root, kind: "local" as const, slug: "local-test" };
		const dir = await ensureCheckout(identity, scratch);
		assert.equal(dir, join(scratch, "local-test"));
		assert.ok(existsSync(join(dir, "README.md")));
		const sha = await headSha(dir);
		assert.match(sha, /^[0-9a-f]{7,12}$/);
		assert.equal(await ensureCheckout(identity, scratch), dir, "second call reuses the clone");
	});

	it("reads the origin of a checkout", async () => {
		const root = await makeRepo();
		roots.push(root);
		git(root, "remote", "add", "origin", "https://github.com/o/n");
		assert.equal(await originOf(root), "https://github.com/o/n");
		const bare = await makeRepo();
		roots.push(bare);
		assert.equal(await originOf(bare), undefined);
	});
});