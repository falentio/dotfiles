import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkoutDir, ensureCheckout, headSha, originOf, refreshCheckout } from "../checkout.ts";
import { localRepoIdentity } from "../repo-id.ts";
import type { PackageRepoResult } from "../registry.ts";
import { identifyRepo, runPackageRepo } from "../tools.ts";

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
		assert.match(text, /ref none \(tried v1\.0\.0\)/);
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
			runPackageRepo({ package: "x", source: "conda" as never }),
			/unknown source: conda\. Supported: npm, jsr, crate, pypi, dockerhub, go, hex, maven, nuget, zig\./,
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
		const { dir } = await ensureCheckout(identity, scratch);
		assert.match(dir, /local-test-[0-9a-f]{10}$/);
		assert.ok(existsSync(join(dir, "README.md")));
		assert.match(await headSha(dir), /^[0-9a-f]{7,12}$/);
		assert.equal((await ensureCheckout(identity, scratch)).dir, dir, "second call reuses the clone");
	});

	it("checks out a pinned ref into its own directory", async () => {
		const root = await makeRepo();
		git(root, "tag", "-a", "v1.0.0", "-m", "release");
		await writeFile(join(root, "README.md"), "changed after the tag\n");
		git(root, "commit", "--quiet", "-am", "second");

		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(scratch);
		const identity = localRepoIdentity(root, undefined);

		assert.match(checkoutDir(identity, scratch), new RegExp(identity.slug + "-[0-9a-f]{10}$"));
		const { dir: pinned } = await ensureCheckout(identity, scratch, "v1.0.0");
		assert.match(pinned, new RegExp(identity.slug + "-[0-9a-f]{10}$"));
		const readme = execFileSync("cat", [join(pinned, "README.md")], { encoding: "utf8" });
		assert.equal(readme, "hello\n", "the tagged tree, not the tip");

		const { dir: head } = await ensureCheckout(identity, scratch);
		const tip = execFileSync("cat", [join(head, "README.md")], { encoding: "utf8" });
		assert.equal(tip, "changed after the tag\n");
		assert.notEqual(pinned, head, "two refs are two trees");
	});

	it("checks out a commit ref, which clone --branch cannot", async () => {
		const root = await makeRepo();
		const sha = git(root, "rev-parse", "HEAD");
		await writeFile(join(root, "README.md"), "after the commit\n");
		git(root, "commit", "--quiet", "-am", "second");
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(root, scratch);
		const identity = localRepoIdentity(root, undefined);
		const { dir } = await ensureCheckout(identity, scratch, sha);
		const readme = execFileSync("cat", [join(dir, "README.md")], { encoding: "utf8" });
		assert.equal(readme, "hello\n", "the commit's tree, not the tip");
	});

	it("reports a refresh that cannot reach the ref", async () => {
		const root = await makeRepo();
		git(root, "tag", "v9.9.9");
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(root, scratch);
		const identity = localRepoIdentity(root, undefined);
		const { dir } = await ensureCheckout(identity, scratch, "v9.9.9");
		git(root, "tag", "-d", "v9.9.9");
		await assert.rejects(refreshCheckout(dir, "v9.9.9"), /git (fetch|checkout) failed/);
	});

	it("re-clones a checkout whose origin is another repo, and says so", async () => {
		const first = await makeRepo();
		const second = await makeRepo();
		await writeFile(join(second, "README.md"), "second\n");
		git(second, "commit", "--quiet", "-am", "second");
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(first, second, scratch);
		const identity = localRepoIdentity(first, undefined);
		await ensureCheckout(identity, scratch);
		const moved = { ...identity, source: second };
		const reused = await ensureCheckout(moved, scratch);
		assert.match(reused.warning ?? "", /re-cloned/);
		const readme = execFileSync("cat", [join(reused.dir, "README.md")], { encoding: "utf8" });
		assert.equal(readme, "second\n", "the tree now belongs to the source asked for");
	});

	it("clones a local repo from its own path, even when its origin names a remote", async () => {
		const root = await makeRepo();
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(root, scratch);
		git(root, "remote", "add", "origin", "https://github.com/example/does-not-exist.git");
		const identity = localRepoIdentity(root, await originOf(root));
		assert.equal(identity.key, "github.com/example/does-not-exist");
		assert.equal(identity.kind, "local");
		assert.equal(identity.source, root);
		const { dir } = await ensureCheckout(identity, scratch);
		assert.ok(existsSync(join(dir, "README.md")));
	});

	it("refuses a ref git would read as an option", async () => {
		const root = await makeRepo();
		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		roots.push(root, scratch);
		const identity = localRepoIdentity(root, undefined);
		const marker = join(scratch, "pwned");
		const hostile = "--upload-pack=echo pwned > " + marker;
		await assert.rejects(ensureCheckout(identity, scratch, hostile), /ref is not a git ref/);
		const { dir } = await ensureCheckout(identity, scratch, "main");
		await assert.rejects(refreshCheckout(dir, hostile), /ref is not a git ref/);
		assert.equal(existsSync(marker), false, "git ran the ref as a command");
	});

	it("reads the origin of a checkout", async () => {
		const root = await makeRepo();
		git(root, "remote", "add", "origin", "https://github.com/o/n");
		assert.equal(await originOf(root), "https://github.com/o/n");
		const bare = await makeRepo();
		assert.equal(await originOf(bare), undefined);
	});
});
