/**
 * The tools over real inputs: repo identification and ref keys (no network), package_repo's
 * validation and rendering (a fake resolver), and the scratch checkout (a real local git repo).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkoutDir, ensureCheckout, headSha, originOf } from "../checkout.ts";
import { localRepoIdentity, parseRemoteRepo } from "../repo-id.ts";
import type { PackageRepoResult } from "../registry.ts";
import { identifyRepo, runPackageRepo, scoutKey } from "../tools.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } }).trim();

const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const makeRepo = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "repo-scout-test-"));
	roots.push(root);
	git(root, "init", "--quiet", "--initial-branch", "main");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	await writeFile(join(root, "README.md"), "hello\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "first");
	return root;
};

const sample = (overrides: Partial<PackageRepoResult> = {}): PackageRepoResult => ({
	package: "zod",
	source: "npm",
	version: "4.0.7",
	repos: [
		{
			url: "https://github.com/colinhacks/zod",
			kind: "repository",
			via: "manifest",
			confidence: "stated",
			ref: "v4.0.7",
			refKind: "tag",
			refCandidates: ["v4.0.7", "4.0.7", "zod@4.0.7"],
		},
	],
	warnings: [],
	...overrides,
});

describe("identifyRepo", () => {
	it("finds a local checkout and keys it by origin", async () => {
		const root = await makeRepo();
		git(root, "remote", "add", "origin", "git@github.com:colinhacks/zod.git");
		const identity = await identifyRepo(root, tmpdir());
		assert.equal(identity.key, "github.com/colinhacks/zod");
		assert.equal(identity.source, root);
		assert.equal(identity.kind, "local");
	});
});

describe("scoutKey", () => {
	it("gives each ref its own conversation, and the default branch none", () => {
		const identity = parseRemoteRepo("github.com/o/n");
		assert.equal(scoutKey(identity), "github.com/o/n");
		assert.equal(scoutKey(identity, "v4.0.7"), "github.com/o/n@v4.0.7");
		assert.notEqual(scoutKey(identity, "v4.0.7"), scoutKey(identity, "v4.0.6"));
	});
});

describe("runPackageRepo", () => {
	it("renders the clone target, provenance, and the confirmed ref", async () => {
		const { text, data } = await runPackageRepo({ package: "zod" }, async () => sample());
		assert.match(text, /^package  zod$/m);
		assert.match(text, /^source   npm$/m);
		assert.match(text, /^version  4\.0\.7$/m);
		assert.match(text, /github\.com\/colinhacks\/zod  \(repository, manifest, stated\)  ref v4\.0\.7 \(tag\)/);
		assert.match(text, /^clone    https:\/\/github\.com\/colinhacks\/zod ref=v4\.0\.7$/m);
		assert.equal(data.repos[0]?.ref, "v4.0.7");
	});

	it("says the default branch when no tag matched", async () => {
		const { text } = await runPackageRepo({ package: "ghost" }, async () =>
			sample({
				package: "ghost",
				repos: [
					{
						url: "https://github.com/o/ghost",
						kind: "repository",
						via: "manifest",
						confidence: "stated",
						ref: null,
						refKind: null,
						refCandidates: ["v1.0.0"],
					},
				],
				warnings: ["no tag matched on https://github.com/o/ghost; tried v1.0.0"],
			}),
		);
		assert.match(text, /ref none/);
		assert.match(text, /^clone    https:\/\/github\.com\/o\/ghost ref=\(default branch\)$/m);
		assert.match(text, /^warning  no tag matched/m);
	});

	it("reports none rather than a clone line when only a tarball is known", async () => {
		const { text } = await runPackageRepo({ package: "x" }, async () =>
			sample({
				repos: [
					{
						url: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
						kind: "tarball",
						via: "npm-tarball",
						confidence: "stated",
						ref: null,
						refKind: null,
						refCandidates: [],
					},
				],
			}),
		);
		assert.match(text, /\(tarball, npm-tarball, stated\)/);
		assert.doesNotMatch(text, /^clone /m);
	});

	it("offers no clone target when every URL is a guess", async () => {
		const { text } = await runPackageRepo({ package: "path" }, async () =>
			sample({
				repos: [
					{
						url: "https://github.com/jaraco/path",
						kind: "repository",
						via: "github-search",
						confidence: "guess",
						ref: null,
						refKind: null,
						refCandidates: [],
					},
				],
				warnings: ["no stated repository: every URL here is a name-search guess, so verify it before reading"],
			}),
		);
		assert.match(text, /github-search, guess/);
		assert.doesNotMatch(text, /^clone /m);
		assert.match(text, /^warning  no stated repository/m);
	});

	it("passes source and version through, and defaults the source to npm", async () => {
		const seen: Array<{ package: string; source?: string; version?: string }> = [];
		const resolve = async (input: { package: string; source?: string; version?: string }) => {
			seen.push(input);
			return sample();
		};
		await runPackageRepo({ package: "serde" }, resolve as never);
		await runPackageRepo({ package: "serde", source: "crate", version: "1.0.229" }, resolve as never);
		assert.deepEqual(seen[0], { package: "serde", source: "npm", version: undefined });
		assert.deepEqual(seen[1], { package: "serde", source: "crate", version: "1.0.229" });
	});

	it("rejects a source it cannot read, naming the ones it can", async () => {
		await assert.rejects(
			runPackageRepo({ package: "x", source: "maven" as never }),
			/unknown source: maven\. Supported: npm, jsr, crate, pypi, dockerhub\./,
		);
		await assert.rejects(runPackageRepo({ package: "  " }), /package is empty/);
	});
});

describe("ensureCheckout", () => {
	it("clones a local repo once and reuses the clone", async () => {
		const root = await makeRepo();
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(scratch);
		const identity = {
			key: "local:" + root,
			source: root,
			display: root,
			kind: "local" as const,
			slug: "local-test",
		};
		const dir = await ensureCheckout(identity, scratch);
		assert.equal(dir, join(scratch, "local-test"));
		assert.ok(existsSync(join(dir, "README.md")));
		assert.match(await headSha(dir), /^[0-9a-f]{7,12}$/);
		assert.equal(await ensureCheckout(identity, scratch), dir, "second call reuses the clone");
	});

	it("checks out a pinned ref into its own directory", async () => {
		const root = await makeRepo();
		git(root, "tag", "-a", "v1.0.0", "-m", "release");
		await writeFile(join(root, "README.md"), "changed after the tag\n");
		git(root, "commit", "--quiet", "-am", "second");

		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(scratch);
		const identity = localRepoIdentity(root, undefined);

		assert.equal(checkoutDir(identity, scratch), join(scratch, identity.slug));
		const pinned = await ensureCheckout(identity, scratch, "v1.0.0");
		assert.equal(pinned, join(scratch, identity.slug + "@v1.0.0"));
		const readme = execFileSync("cat", [join(pinned, "README.md")], { encoding: "utf8" });
		assert.equal(readme, "hello\n", "the tagged tree, not the tip");

		const head = await ensureCheckout(identity, scratch);
		const tip = execFileSync("cat", [join(head, "README.md")], { encoding: "utf8" });
		assert.equal(tip, "changed after the tag\n");
		assert.notEqual(pinned, head, "two refs are two trees");
	});

	it("clones a local repo from its own path, even when its origin names a remote", async () => {
		const root = await makeRepo();
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(root, scratch);
		// An origin that cannot be fetched: if the clone went to the remote, this test fails.
		git(root, "remote", "add", "origin", "https://github.com/example/does-not-exist.git");
		const identity = localRepoIdentity(root, await originOf(root));
		assert.equal(identity.key, "github.com/example/does-not-exist");
		assert.equal(identity.kind, "local");
		assert.equal(identity.source, root);
		const dir = await ensureCheckout(identity, scratch);
		assert.ok(existsSync(join(dir, "README.md")));
	});

	it("reads the origin of a checkout", async () => {
		const root = await makeRepo();
		git(root, "remote", "add", "origin", "https://github.com/o/n");
		assert.equal(await originOf(root), "https://github.com/o/n");
		const bare = await makeRepo();
		assert.equal(await originOf(bare), undefined);
	});
});
