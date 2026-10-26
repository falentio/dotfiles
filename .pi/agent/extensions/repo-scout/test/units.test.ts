/**
 * The pure rules: repo identity, and each package registry parser against a fixture shaped like the
 * real response. No model, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { localRepoIdentity, parseRemoteRepo, sessionFileName } from "../repo-id.ts";
import {
	isRepoRootUrl,
	matchRef,
	mergeRepos,
	normalizeRepoUrl,
	npmManifest,
	npmVersion,
	parseJsrMeta,
	parseNpm,
	pickVersion,
	refCandidates,
	reposFromDockerhubHub,
	reposFromGithubSearch,
	reposFromJsrDenoJson,
	reposFromManifest,
	reposFromPypi,
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
		it(input + " -> " + key, () => {
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
	it("keys a local checkout by its origin, so a worktree shares the remote session", () => {
		const identity = localRepoIdentity("/work/zod-feature", "git@github.com:colinhacks/zod.git");
		assert.equal(identity.key, "github.com/colinhacks/zod");
		assert.equal(identity.source, "/work/zod-feature");
		assert.equal(identity.kind, "local", "the tree read is the local path, not the remote");
	});

	it("falls back to the path when there is no origin", () => {
		assert.equal(localRepoIdentity("/tmp/scratch", undefined).key, "local:/tmp/scratch");
		assert.equal(localRepoIdentity("/tmp/scratch", undefined).kind, "local");
	});
});

describe("sessionFileName", () => {
	it("is a safe filename for every key shape", () => {
		assert.equal(sessionFileName("github.com/colinhacks/zod"), "github.com_colinhacks_zod");
		assert.match(sessionFileName("local:/tmp/a b"), /^local-_tmp_a_b$/);
		assert.match(sessionFileName("github.com/a/b@v1.0.0"), /^[\w.@-]+$/);
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
		it(JSON.stringify(input) + " -> " + (expected ?? "undefined"), () => {
			assert.equal(normalizeRepoUrl(input), expected);
		});
	}
});

describe("isRepoRootUrl", () => {
	it("accepts a forge repo root and rejects a page inside one", () => {
		assert.equal(isRepoRootUrl("https://github.com/o/n"), true);
		assert.equal(isRepoRootUrl("https://github.com/o/n/issues"), false);
		assert.equal(isRepoRootUrl("https://github.com/o/n/tree/main/x"), false);
		assert.equal(isRepoRootUrl("https://zod.dev"), false);
		assert.equal(isRepoRootUrl("https://codeberg.org/o/n"), true);
		assert.equal(isRepoRootUrl("https://hub.docker.com/_/postgres"), false, "a hub page is not a repo");
		assert.equal(isRepoRootUrl("https://git.example.com/o/n"), true);
		assert.equal(isRepoRootUrl("https://example.com/o/n", "https://example.com/o/n.git"), true);
	});
});

describe("manifest -> repos", () => {
	it("puts repository before homepage and dedupes", () => {
		const refs = reposFromManifest({
			homepage: "https://github.com/o/n#readme",
			repository: { type: "git", url: "git+https://github.com/o/n.git" },
		});
		assert.deepEqual(refs.map((entry) => entry.url), ["https://github.com/o/n"]);
		assert.equal(refs[0]?.confidence, "stated");
		assert.equal(refs[0]?.via, "manifest");
		assert.equal(refs[0]?.ref, null, "no ref before git confirms one");
	});

	it("drops a bugs page and a docs homepage, which cannot be cloned", () => {
		const refs = reposFromManifest({
			repository: { url: "git+https://github.com/colinhacks/zod.git" },
			bugs: { url: "https://github.com/colinhacks/zod/issues" },
			homepage: "https://zod.dev",
		});
		assert.deepEqual(refs.map((entry) => entry.url), ["https://github.com/colinhacks/zod"]);
	});

	it("drops a docs site or project page in the repository field", () => {
		assert.deepEqual(reposFromManifest({ repository: "https://pypi.org/project/requests" }), []);
		assert.deepEqual(reposFromManifest({ repository: "https://requests.readthedocs.io/en/latest/" }), []);
	});

	it("keeps a homepage that is itself a repo root", () => {
		const refs = reposFromManifest({ homepage: "https://codeberg.org/o/n" });
		assert.deepEqual(refs.map((entry) => entry.url), ["https://codeberg.org/o/n"]);
	});
});

describe("npm", () => {
	const packument = {
		"dist-tags": { latest: "4.0.7", next: "5.0.0-beta.1" },
		versions: {
			"4.0.7": { repository: { url: "git+https://github.com/colinhacks/zod.git" } },
			"3.0.0": { repository: { url: "git+https://github.com/colinhacks/zod.git" } },
		},
	};

	it("reads the latest version and its manifest", () => {
		assert.equal(npmVersion(packument), "4.0.7");
		const manifest = npmManifest(packument, "4.0.7");
		assert.equal(reposFromManifest(manifest!)[0]?.url, "https://github.com/colinhacks/zod");
	});

	it("honours a requested version", () => {
		const parsed = parseNpm(packument, "3.0.0");
		assert.equal(parsed.version, "3.0.0");
		assert.equal(parsed.repos.length, 1);
		assert.deepEqual(parsed.warnings, []);
	});

	it("warns about a version the registry does not have", () => {
		const parsed = parseNpm(packument, "9.9.9");
		assert.equal(parsed.version, "9.9.9");
		assert.match(parsed.warnings[0] ?? "", /no version 9\.9\.9/);
	});

	it("falls back to the tarball, marked as not browsable", () => {
		const manifest = npmManifest({
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } } },
		});
		assert.equal(reposFromManifest(manifest!).length, 0);
		const tarball = tarballFromNpmManifest(manifest!);
		assert.equal(tarball?.kind, "tarball");
		assert.equal(tarball?.via, "npm-tarball");
	});
});

describe("jsr", () => {
	it("reads versions and the latest", () => {
		const meta = parseJsrMeta({ latest: "1.1.6", versions: { "1.1.6": {}, "0.1.0": {} } });
		assert.equal(meta.latest, "1.1.6");
		assert.deepEqual(meta.versions, ["1.1.6", "0.1.0"]);
	});

	it("reads githubRepository out of a version deno.json", () => {
		const refs = reposFromJsrDenoJson({ name: "@o/n", version: "1.1.6", githubRepository: "o/n" });
		assert.equal(refs[0]?.url, "https://github.com/o/n");
		assert.equal(refs[0]?.via, "jsr-deno-json");
	});

	it("finds no repo when the deno.json has none", () => {
		assert.deepEqual(reposFromJsrDenoJson({ name: "@std/path", version: "1.1.6" }), []);
	});
});

describe("pypi", () => {
	it("prefers a Source project URL", () => {
		const refs = reposFromPypi({
			version: "2.34.2",
			project_urls: {
				Documentation: "https://requests.readthedocs.io",
				Source: "https://github.com/psf/requests",
			},
		});
		assert.deepEqual(refs.map((entry) => entry.url), ["https://github.com/psf/requests"]);
		assert.equal(refs[0]?.via, "pypi-project-urls");
	});

	it("uses a repo-root home_page", () => {
		const refs = reposFromPypi({ home_page: "https://github.com/o/n" });
		assert.deepEqual(refs.map((entry) => entry.url), ["https://github.com/o/n"]);
	});

	it("ignores a docs site", () => {
		assert.deepEqual(reposFromPypi({ project_urls: { Homepage: "https://requests.readthedocs.io" } }), []);
	});
});

describe("dockerhub", () => {
	it("takes a repo root out of the description", () => {
		const refs = reposFromDockerhubHub({
			description: "Postgres image",
			full_description:
				"Source: https://github.com/docker-library/postgres. Docs: https://hub.docker.com/_/postgres",
		});
		assert.deepEqual(refs.map((entry) => entry.url), ["https://github.com/docker-library/postgres"]);
		assert.equal(refs[0]?.via, "dockerhub-description");
	});

	it("finds nothing when the description links no repo", () => {
		assert.deepEqual(reposFromDockerhubHub({ description: "docs at https://grafana.com/docs/" }), []);
	});
});

describe("refs", () => {
	it("proposes the tags a version is usually published under", () => {
		assert.deepEqual(refCandidates("npm", "zod", "4.0.7"), ["v4.0.7", "4.0.7", "zod@4.0.7"]);
		assert.deepEqual(refCandidates("crate", "serde", "1.0.229"), [
			"v1.0.229",
			"1.0.229",
			"serde-v1.0.229",
			"serde-1.0.229",
		]);
		assert.deepEqual(refCandidates("pypi", "requests", "2.34.2"), ["v2.34.2", "2.34.2", "requests-2.34.2"]);
		assert.deepEqual(refCandidates("dockerhub", "o/n", "latest"), [], "a Docker tag is not a git ref");
		assert.deepEqual(refCandidates("npm", "zod", null), []);
	});

	it("matches a tag before a branch", () => {
		const remotes = { tags: ["v4.0.7"], branches: ["4.0.7", "main"] };
		assert.deepEqual(matchRef(["4.0.7", "v4.0.7"], remotes), { ref: "v4.0.7", refKind: "tag" });
		assert.deepEqual(matchRef(["4.0.7"], remotes), { ref: "4.0.7", refKind: "branch" });
		assert.equal(matchRef(["nope"], remotes), null);
	});

	it("takes the requested version over the latest", () => {
		assert.equal(pickVersion("3.0.0", "4.0.7", ["4.0.7"]), "3.0.0");
		assert.equal(pickVersion(undefined, "4.0.7", ["4.0.7"]), "4.0.7");
		assert.equal(pickVersion(undefined, null, ["0.1.0"]), "0.1.0");
	});
});

describe("github search", () => {
	it("is always a guess, deduped by URL", () => {
		const refs = reposFromGithubSearch({
			items: [{ html_url: "https://github.com/o/n" }, { html_url: "https://github.com/o/n" }],
		});
		assert.equal(refs.length, 1);
		assert.equal(refs[0]?.confidence, "guess");
		assert.equal(refs[0]?.via, "github-search");
	});
});

describe("mergeRepos", () => {
	it("keeps first-wins order", () => {
		const stated = reposFromManifest({ repository: "https://github.com/o/a" });
		const guess = reposFromGithubSearch({ items: [{ html_url: "https://github.com/o/a" }] });
		assert.equal(mergeRepos(stated, guess).length, 1);
		assert.equal(mergeRepos(stated, guess)[0]?.via, "manifest");
	});
});
