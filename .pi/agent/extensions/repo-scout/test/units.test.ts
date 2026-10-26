/**
 * The pure rules: repo identity, package provenance parsing, and the registry's queue and idle
 * clock. No model, no network, no git.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localRepoIdentity, parseRemoteRepo, sessionFileName } from "../repo-id.ts";
import {
	jsrMetaUrl,
	mergeRepos,
	normalizeRepoUrl,
	npmManifest,
	npmPackageUrl,
	npmVersion,
	reposFromGithubSearch,
	reposFromManifest,
	tarballFromNpmManifest,
} from "../registry.ts";

/** Every spelling of one repo, in the shapes callers actually pass. */
describe("parseRemoteRepo", () => {
	const cases: Array<[string, string]> = [
		["https://github.com/colinhacks/zod", "github.com/colinhacks/zod"],
		["https://github.com/colinhacks/zod.git", "github.com/colinhacks/zod"],
		["https://github.com/ColinHacks/Zod/", "github.com/colinhacks/zod"],
		["https://github.com/colinhacks/zod/tree/v4.0.7/packages", "github.com/colinhacks/zod"],
		["https://github.com/colinhacks/zod?tab=readme#install", "github.com/colinhacks/zod"],
		["git@github.com:colinhacks/zod.git", "github.com/colinhacks/zod"],
		["ssh://git@github.com/colinhacks/zod.git", "github.com/colinhacks/zod"],
		["git://github.com/colinhacks/zod", "github.com/colinhacks/zod"],
		["github.com/colinhacks/zod", "github.com/colinhacks/zod"],
		["colinhacks/zod", "github.com/colinhacks/zod"],
		["https://gitlab.com/group/name", "gitlab.com/group/name"],
	];

	for (const [input, key] of cases) {
		it(`${input} -> ${key}`, () => {
			assert.equal(parseRemoteRepo(input).key, key);
		});
	}

	it("clones from the canonical https URL, not the git+ssh form", () => {
		const identity = parseRemoteRepo("git@github.com:colinhacks/zod.git");
		assert.equal(identity.source, "https://github.com/colinhacks/zod");
		assert.equal(identity.kind, "remote");
	});

	it("gives every key a directory-safe slug", () => {
		const slug = parseRemoteRepo("https://github.com/a/b").slug;
		assert.equal(slug, "github.com-a-b");
		assert.match(slug, /^[a-z0-9.-]+$/);
		assert.match(parseRemoteRepo("https://github.com/Foo/Bar").slug, /^[a-z0-9.-]+$/);
	});

	it("rejects a reference with no owner and repo", () => {
		assert.throws(() => parseRemoteRepo("https://github.com/justowner"), /owner and a repo/);
		assert.throws(() => parseRemoteRepo("   "), /empty/);
	});
});

describe("localRepoIdentity", () => {
	it("keys a local checkout by its origin, so a worktree matches the remote", () => {
		const identity = localRepoIdentity("/work/zod-feature", "git@github.com:colinhacks/zod.git");
		assert.equal(identity.key, "github.com/colinhacks/zod");
		assert.equal(identity.source, "/work/zod-feature");
	});

	it("falls back to the path when there is no origin", () => {
		assert.equal(localRepoIdentity("/tmp/scratch", undefined).key, "local:/tmp/scratch");
	});
});

describe("sessionFileName", () => {
	it("is a safe filename for every key shape", () => {
		assert.equal(sessionFileName("github.com/colinhacks/zod"), "github.com_colinhacks_zod");
		assert.match(sessionFileName("local:/tmp/a b"), /^local-_tmp_a_b$/);
	});
});

describe("normalizeRepoUrl", () => {
	const cases: Array<[unknown, string | undefined]> = [
		["git+https://github.com/o/n.git", "https://github.com/o/n"],
		["git://github.com/o/n.git", "https://github.com/o/n"],
		["git@github.com:o/n.git", "https://github.com/o/n"],
		["ssh://git@github.com/o/n", "https://github.com/o/n"],
		["github:o/n", "https://github.com/o/n"],
		["o/n", "https://github.com/o/n"],
		[{ type: "git", url: "git+ssh://git@github.com/o/n.git" }, "https://github.com/o/n"],
		[{ url: "https://codeberg.org/o/n" }, "https://codeberg.org/o/n"],
		["", undefined],
		[undefined, undefined],
		["not a repo", undefined],
	];

	for (const [input, expected] of cases) {
		it(`${JSON.stringify(input)} -> ${expected ?? "undefined"}`, () => {
			assert.equal(normalizeRepoUrl(input), expected);
		});
	}
});

describe("manifest -> repos", () => {
	it("puts repository before homepage and dedupes", () => {
		const refs = reposFromManifest({
			homepage: "https://github.com/o/n#readme",
			repository: { type: "git", url: "git+https://github.com/o/n.git" },
		});
		assert.deepEqual(refs.map((ref) => ref.url), ["https://github.com/o/n"]);
		assert.equal(refs[0]?.confidence, "stated");
	});

	it("drops a bugs page and a docs homepage, which cannot be cloned", () => {
		const refs = reposFromManifest({
			repository: { url: "git+https://github.com/colinhacks/zod.git" },
			bugs: { url: "https://github.com/colinhacks/zod/issues" },
			homepage: "https://zod.dev",
		});
		assert.deepEqual(refs.map((ref) => ref.url), ["https://github.com/colinhacks/zod"]);
	});

	it("keeps a homepage that is itself a repo root", () => {
		const refs = reposFromManifest({ homepage: "https://codeberg.org/o/n" });
		assert.deepEqual(refs.map((ref) => ref.url), ["https://codeberg.org/o/n"]);
	});

	it("reads the latest version out of a packument", () => {
		const packument = {
			"dist-tags": { latest: "4.0.7", next: "5.0.0-beta.1" },
			versions: {
				"4.0.7": { repository: { url: "git+https://github.com/colinhacks/zod.git" } },
			},
		};
		assert.equal(npmVersion(packument), "4.0.7");
		assert.equal(reposFromManifest(npmManifest(packument)!)[0]?.url, "https://github.com/colinhacks/zod");
	});

	it("falls back to the tarball, marked as not browsable", () => {
		const manifest = npmManifest({
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } } },
		});
		assert.equal(reposFromManifest(manifest!).length, 0);
		assert.equal(tarballFromNpmManifest(manifest!)?.kind, "tarball");
	});

	it("marks a GitHub search hit as a guess", () => {
		const refs = reposFromGithubSearch({ items: [{ html_url: "https://github.com/o/n" }, { html_url: "https://github.com/o/n" }] });
		assert.equal(refs.length, 1);
		assert.equal(refs[0]?.confidence, "guess");
	});

	it("npm scoped names are percent-encoded, jsr names are scoped", () => {
		assert.equal(npmPackageUrl("@scope/name"), "https://registry.npmjs.org/@scope%2Fname");
		assert.equal(jsrMetaUrl("@scope/name"), "https://jsr.io/@scope/name/meta.json");
		assert.equal(jsrMetaUrl("unscoped"), undefined);
	});

	it("merge keeps first-wins order", () => {
		const a = [{ url: "https://github.com/o/a", kind: "repository" as const, source: "manifest" as const, confidence: "stated" as const }];
		const b = [{ url: "https://github.com/o/a", kind: "repository" as const, source: "github-search" as const, confidence: "guess" as const }];
		assert.equal(mergeRepos(a, b).length, 1);
		assert.equal(mergeRepos(a, b)[0]?.source, "manifest");
	});
});