/**
 * resolvePackageRepo over fake registries and a fake git: every source's shape, version selection, and
 * the rule that a ref is only reported after git confirms it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type RegistryDeps,
	type RemoteRefs,
	cloneTarget,
	isRepoRootUrl,
	resolvePackageRepo,
} from "../registry.ts";

const NPM_PACKUMENT = {
	"dist-tags": { latest: "4.0.7" },
	versions: {
		"4.0.7": { repository: { url: "git+https://github.com/colinhacks/zod.git" } },
	},
};

const CRATE = {
	crate: {
		max_version: "1.0.229",
		repository: "https://github.com/serde-rs/serde",
		homepage: "https://serde.rs",
	},
};

const PYPI = {
	info: { version: "2.34.2", project_urls: { Source: "https://github.com/psf/requests" } },
	releases: { "2.34.2": {}, "2.34.1": {} },
};

const JSR_META = { latest: "1.1.6", versions: { "1.1.6": {}, "0.1.0": {} } };
const JSR_DENO = { name: "@o/n", version: "1.1.6", githubRepository: "o/n" };

const DOCKERHUB = {
	description: "The image",
	full_description: "Source: https://github.com/docker-library/postgres.",
};


const GO_INFO = {
	Version: "v1.10.0",
	Origin: { VCS: "git", URL: "https://github.com/gin-gonic/gin", Ref: "refs/tags/v1.10.0" },
};

const GO_VANITY_META =
	'<meta name="go-import" content="gopkg.in/yaml.v3 git https://github.com/go-yaml/yaml">';

const HEX_PACKAGE = {
	name: "phoenix",
	meta: {
		links: {
			Changelog: "https://hexdocs.pm/phoenix/changelog.html",
			GitHub: "https://github.com/phoenixframework/phoenix",
		},
	},
	releases: [{ version: "1.8.16" }, { version: "1.7.14" }],
};

const MAVEN_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<metadata><groupId>com.example</groupId><artifactId>guava</artifactId>
<versioning><latest>3.17.0</latest><release>3.17.0</release>
<versions><version>3.16.0</version><version>3.17.0</version></versions></versioning></metadata>`;

const MAVEN_POM = `<project>
  <url>https://example.github.io/guava/</url>
  <scm><developerConnection>scm:git:https://github.com/google/guava.git</developerConnection>
  <url>https://github.com/google/guava</url></scm>
</project>`;

const NUGET_INDEX = { versions: ["12.0.3", "13.0.3"] };

const NUGET_NUSPEC =
	'<package><id>Newtonsoft.Json</id><repository type="git" url="https://github.com/JamesNK/Newtonsoft.Json" /></package>';

const ZPM = [
	{
		author: "BanchouBoo",
		name: "accord",
		git: "https://github.com/BanchouBoo/accord.git",
		links: { github: "https://github.com/BanchouBoo/accord" },
	},
	{
		author: "someone",
		name: "accord",
		git: "https://github.com/someone/accord.git",
		links: {},
	},
];

type Fixtures = {
	json?: Record<string, unknown>;
	text?: Record<string, string>;
	refs?: Record<string, RemoteRefs>;
	/** URL prefixes that must 404, checked before the fixtures. */
	missing?: string[];
};

const deps = (fixtures: Fixtures) => {
	const requested: string[] = [];
	const listed: string[] = [];
	const impl: RegistryDeps = {
		async fetchJson(url) {
			requested.push(url);
			if (fixtures.missing?.some((candidate) => url.startsWith(candidate))) {
				throw new Error("GET " + url + " -> 404 Not Found");
			}
			const key = Object.keys(fixtures.json ?? {}).find((candidate) => url.startsWith(candidate));
			if (!key) throw new Error("no fixture for " + url);
			return fixtures.json?.[key];
		},
		async fetchText(url) {
			requested.push(url);
			const key = Object.keys(fixtures.text ?? {}).find((candidate) => url.startsWith(candidate));
			if (!key) throw new Error("no fixture for " + url);
			return fixtures.text?.[key] ?? "";
		},
		async lsRemote(url) {
			listed.push(url);
			return fixtures.refs?.[url] ?? { tags: [], branches: [] };
		},
	};
	return { impl, requested, listed };
};

describe("resolvePackageRepo", () => {
	it("npm: latest version, stated repo, and the confirmed tag", async () => {
		const { impl, requested, listed } = deps({
			json: { "https://registry.npmjs.org/zod": NPM_PACKUMENT },
			refs: { "https://github.com/colinhacks/zod": { tags: ["v4.0.7"], branches: ["main"] } },
		});
		const result = await resolvePackageRepo({ package: "zod" }, impl);

		assert.equal(result.source, "npm");
		assert.equal(result.version, "4.0.7");
		assert.equal(result.repos[0]?.url, "https://github.com/colinhacks/zod");
		assert.equal(result.repos[0]?.ref, "v4.0.7");
		assert.equal(result.repos[0]?.refKind, "tag");
		assert.deepEqual(result.warnings, []);
		assert.deepEqual(requested, ["https://registry.npmjs.org/zod"]);
		assert.deepEqual(listed, ["https://github.com/colinhacks/zod"]);
		assert.deepEqual(cloneTarget(result), { url: "https://github.com/colinhacks/zod", ref: "v4.0.7" });
	});

	it("npm: a requested version wins, and is looked up in that version's manifest", async () => {
		const packument = {
			"dist-tags": { latest: "4.0.7" },
			versions: {
				"4.0.7": { repository: { url: "https://github.com/colinhacks/zod" } },
				"3.0.0": { repository: { url: "https://github.com/colinhacks/zod" } },
			},
		};
		const { impl } = deps({
			json: { "https://registry.npmjs.org/zod": packument },
			refs: { "https://github.com/colinhacks/zod": { tags: ["v3.0.0"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "zod", version: "3.0.0" }, impl);
		assert.equal(result.version, "3.0.0");
		assert.equal(result.repos[0]?.ref, "v3.0.0");
	});

	it("npm: no matching tag means no ref, the candidates, and a warning", async () => {
		const { impl } = deps({
			json: { "https://registry.npmjs.org/zod": NPM_PACKUMENT },
			refs: { "https://github.com/colinhacks/zod": { tags: ["r4.0.7"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "zod" }, impl);
		assert.equal(result.repos[0]?.ref, null);
		assert.deepEqual(result.repos[0]?.refCandidates, ["v4.0.7", "4.0.7", "zod@4.0.7"]);
		assert.match(result.warnings.join("\n"), /no tag matched on https:\/\/github\.com\/colinhacks\/zod/);
	});

	it("npm: a tarball is not cloned and gets no ref", async () => {
		const tarballOnly = {
			"dist-tags": { latest: "1.0.0" },
			versions: { "1.0.0": { dist: { tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz" } } },
		};
		const { impl, listed } = deps({ json: { "https://registry.npmjs.org/x": tarballOnly } });
		const result = await resolvePackageRepo({ package: "x" }, impl);
		assert.equal(result.repos[0]?.kind, "tarball");
		assert.equal(result.repos[0]?.ref, null);
		assert.deepEqual(listed, [], "no git to ask for a tarball");
		assert.equal(cloneTarget(result), null);
	});

	it("crate: reads repository and version, then the v-prefixed tag", async () => {
		const { impl } = deps({
			json: { "https://crates.io/api/v1/crates/serde": CRATE },
			refs: { "https://github.com/serde-rs/serde": { tags: ["v1.0.229"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "serde", source: "crate" }, impl);
		assert.equal(result.version, "1.0.229");
		assert.equal(result.repos[0]?.url, "https://github.com/serde-rs/serde");
		assert.equal(result.repos[0]?.ref, "v1.0.229");
	});

	it("pypi: reads a Source project URL and its version", async () => {
		const { impl } = deps({
			json: { "https://pypi.org/pypi/requests/json": PYPI },
			refs: { "https://github.com/psf/requests": { tags: ["v2.34.2"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "requests", source: "pypi" }, impl);
		assert.equal(result.version, "2.34.2");
		assert.equal(result.repos[0]?.url, "https://github.com/psf/requests");
		assert.equal(result.repos[0]?.via, "pypi-project-urls");
		assert.equal(result.repos[0]?.ref, "v2.34.2");
	});

	it("jsr: reads the version deno.json for the repo, keeping the @ in its URLs", async () => {
		const { impl, requested } = deps({
			json: { "https://jsr.io/@o/n/meta.json": JSR_META },
			text: { "https://jsr.io/@o/n/1.1.6/deno.json": JSON.stringify(JSR_DENO) },
			refs: { "https://github.com/o/n": { tags: ["1.1.6"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "@o/n", source: "jsr" }, impl);
		assert.deepEqual(requested, ["https://jsr.io/@o/n/meta.json", "https://jsr.io/@o/n/1.1.6/deno.json"]);
		assert.equal(result.version, "1.1.6");
		assert.equal(result.repos[0]?.url, "https://github.com/o/n");
		assert.equal(result.repos[0]?.via, "jsr-deno-json");
		assert.equal(result.repos[0]?.ref, "1.1.6");
	});

	it("jsr: a deno.json without a repo falls back to a marked guess", async () => {
		const { impl } = deps({
			json: {
				"https://jsr.io/@o/n/meta.json": JSR_META,
				"https://api.github.com/search/repositories": { items: [{ html_url: "https://github.com/o/n" }] },
			},
			text: { "https://jsr.io/@o/n/1.1.6/deno.json": JSON.stringify({ name: "@o/n" }) },
			refs: { "https://github.com/o/n": { tags: [], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "@o/n", source: "jsr" }, impl);
		assert.equal(result.repos[0]?.confidence, "guess");
		assert.match(result.warnings.join("\n"), /names no githubRepository/);
		assert.match(result.warnings.join("\n"), /no stated repository/);
		assert.equal(cloneTarget(result), null, "a guess is not a destination");
	});

	it("dockerhub: takes the repo out of the description and never claims a git ref", async () => {
		const { impl } = deps({
			json: { "https://hub.docker.com/v2/repositories/library/postgres/": DOCKERHUB },
		});
		const result = await resolvePackageRepo({ package: "library/postgres", source: "dockerhub" }, impl);
		assert.equal(result.repos[0]?.url, "https://github.com/docker-library/postgres");
		assert.equal(result.repos[0]?.ref, null);
		assert.match(result.warnings.join("\n"), /a Docker tag names an image, not a git revision/);
	});

	it("refuses a gitweb page whose query merely ends in .git", () => {
		assert.equal(
			isRepoRootUrl(
				"https://gitbox.apache.org/repos/asf?p=commons-lang",
				"https://gitbox.apache.org/repos/asf?p=commons-lang.git",
			),
			false,
		);
		assert.equal(
			isRepoRootUrl(
				"https://gitbox.apache.org/repos/asf/commons-lang",
				"https://gitbox.apache.org/repos/asf/commons-lang.git",
			),
			true,
			"a clone path that ends in .git is still a repo",
		);
	});

	it("drops a manifest URL that points at a private host, and names it", async () => {
		const { impl, listed } = deps({
			json: {
				"https://registry.npmjs.org/x": {
					"dist-tags": { latest: "1.0.0" },
					versions: { "1.0.0": { repository: "http://169.254.169.254/latest/meta-data.git" } },
				},
			},
		});
		const result = await resolvePackageRepo({ package: "x" }, impl);
		assert.deepEqual(result.repos, []);
		assert.deepEqual(listed, [], "git never contacts a private host");
		assert.match(result.warnings.join("\n"), /ignored http:\/\/169\.254\.169\.254\/latest\/meta-data: not a cloneable https git host/);
	});

	it("pypi: warns about a version the registry does not have", async () => {
		const { impl } = deps({
			json: { "https://pypi.org/pypi/requests/json": PYPI },
			refs: { "https://github.com/psf/requests": { tags: ["v99.99.99"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "requests", source: "pypi", version: "99.99.99" }, impl);
		assert.equal(result.version, "99.99.99");
		assert.match(result.warnings.join("\n"), /no pypi release 99\.99\.99/);
	});

	it("rejects a version that is not one path segment, before any fetch", async () => {
		let fetched = 0;
		const impl: RegistryDeps = {
			async fetchJson() {
				fetched += 1;
				throw new Error("fetched");
			},
			async fetchText() {
				fetched += 1;
				return "";
			},
			async lsRemote() {
				fetched += 1;
				return { tags: [], branches: [] };
			},
		};
		await assert.rejects(
			resolvePackageRepo({ package: "@std/path", source: "jsr", version: "x/../../../@std/fs/1.1.6" }, impl),
			/version is not a published version/,
		);
		assert.equal(fetched, 0);
	});

	it("encodes a scoped npm name as one path segment", async () => {
		const { impl, requested } = deps({ json: { "https://registry.npmjs.org/@scope%2Fname": NPM_PACKUMENT } });
		await resolvePackageRepo({ package: "@scope/name" }, impl);
		assert.equal(requested[0], "https://registry.npmjs.org/@scope%2Fname");
	});

	it("dockerhub: warns when the version tag does not exist", async () => {
		const { impl } = deps({
			json: { "https://hub.docker.com/v2/repositories/library/postgres/": DOCKERHUB },
			missing: ["https://hub.docker.com/v2/repositories/library/postgres/tags/"],
		});
		const result = await resolvePackageRepo(
			{ package: "library/postgres", source: "dockerhub", version: "99" },
			impl,
		);
		assert.match(result.warnings.join("\n"), /no tag 99/);
	});


	it("go: reads the origin repo and version from the proxy, then the v tag", async () => {
		const { impl, requested, listed } = deps({
			json: { "https://proxy.golang.org/github.com/gin-gonic/gin/@latest": GO_INFO },
			refs: { "https://github.com/gin-gonic/gin": { tags: ["v1.10.0"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "github.com/gin-gonic/gin", source: "go" }, impl);
		assert.equal(result.version, "v1.10.0");
		assert.equal(result.repos[0]?.url, "https://github.com/gin-gonic/gin");
		assert.equal(result.repos[0]?.via, "go-proxy-origin");
		assert.equal(result.repos[0]?.ref, "v1.10.0");
		assert.deepEqual(requested, ["https://proxy.golang.org/github.com/gin-gonic/gin/@latest"]);
		assert.deepEqual(listed, ["https://github.com/gin-gonic/gin"]);
	});

	it("go: escapes an uppercase module path and reads the requested version", async () => {
		const info = { Version: "v1.9.5", Origin: { URL: "https://github.com/BurntSushi/toml" } };
		const { impl, requested } = deps({
			json: { "https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.9.5.info": info },
			refs: { "https://github.com/BurntSushi/toml": { tags: ["v1.9.5"], branches: [] } },
		});
		const result = await resolvePackageRepo(
			{ package: "github.com/BurntSushi/toml", source: "go", version: "v1.9.5" },
			impl,
		);
		assert.equal(requested[0], "https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.9.5.info");
		assert.equal(result.repos[0]?.ref, "v1.9.5");
	});

	it("go: trusts a proxy origin on a host that is not a known forge", async () => {
		const { impl } = deps({
			json: {
				"https://proxy.golang.org/golang.org/x/text/@latest": {
					Version: "v0.43.0",
					Origin: { VCS: "git", URL: "https://go.googlesource.com/text" },
				},
			},
			refs: { "https://go.googlesource.com/text": { tags: ["v0.43.0"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "golang.org/x/text", source: "go" }, impl);
		assert.equal(result.repos[0]?.url, "https://go.googlesource.com/text");
		assert.equal(result.repos[0]?.ref, "v0.43.0");
	});

	it("go: without an origin, a vanity path reads the go-import meta tag", async () => {
		const { impl } = deps({
			json: { "https://proxy.golang.org/gopkg.in/yaml.v3/@latest": { Version: "v3.0.1" } },
			text: { "https://gopkg.in/yaml.v3?go-get=1": GO_VANITY_META },
			refs: { "https://github.com/go-yaml/yaml": { tags: ["v3.0.1"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "gopkg.in/yaml.v3", source: "go" }, impl);
		assert.equal(result.repos[0]?.url, "https://github.com/go-yaml/yaml");
		assert.equal(result.repos[0]?.via, "go-import-meta");
		assert.equal(result.repos[0]?.ref, "v3.0.1");
	});

	it("hex: reads meta.links and the release list", async () => {
		const { impl } = deps({
			json: { "https://hex.pm/api/packages/phoenix": HEX_PACKAGE },
			refs: { "https://github.com/phoenixframework/phoenix": { tags: ["v1.7.14"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "phoenix", source: "hex", version: "1.7.14" }, impl);
		assert.equal(result.version, "1.7.14");
		assert.equal(result.repos[0]?.url, "https://github.com/phoenixframework/phoenix");
		assert.equal(result.repos[0]?.via, "hex-links");
		assert.equal(result.repos[0]?.ref, "v1.7.14");
	});

	it("maven: metadata picks the release, the pom names the scm repo", async () => {
		const { impl, requested } = deps({
			text: {
				"https://repo1.maven.org/maven2/com/google/guava/guava/maven-metadata.xml": MAVEN_METADATA,
				"https://repo1.maven.org/maven2/com/google/guava/guava/3.17.0/guava-3.17.0.pom": MAVEN_POM,
			},
			refs: { "https://github.com/google/guava": { tags: ["v3.17.0"], branches: [] } },
		});
		const result = await resolvePackageRepo({ package: "com.google.guava:guava", source: "maven" }, impl);
		assert.equal(result.version, "3.17.0");
		assert.equal(result.repos[0]?.url, "https://github.com/google/guava");
		assert.equal(result.repos[0]?.via, "maven-pom");
		assert.equal(result.repos[0]?.ref, "v3.17.0");
		assert.ok(requested.includes("https://repo1.maven.org/maven2/com/google/guava/guava/3.17.0/guava-3.17.0.pom"));
	});

	it("maven: a pom's scm tag is tried before the guessed candidates", async () => {
		const metadata = `<metadata><versioning><release>3.17.0</release>
			<versions><version>3.17.0</version></versions></versioning></metadata>`;
		const pom = `<project><scm>
			<developerConnection>scm:git:https://gitbox.apache.org/repos/asf/commons-lang.git</developerConnection>
			<tag>rel/commons-lang-3.17.0</tag>
		</scm></project>`;
		const { impl } = deps({
			text: {
				"https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/maven-metadata.xml": metadata,
				"https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.17.0/commons-lang3-3.17.0.pom": pom,
			},
			refs: {
				"https://gitbox.apache.org/repos/asf/commons-lang": {
					tags: ["rel/commons-lang-3.17.0"],
					branches: [],
				},
			},
		});
		const result = await resolvePackageRepo(
			{ package: "org.apache.commons:commons-lang3", source: "maven", version: "3.17.0" },
			impl,
		);
		assert.equal(result.repos[0]?.ref, "rel/commons-lang-3.17.0");
		assert.equal(result.repos[0]?.refCandidates[0], "rel/commons-lang-3.17.0");
	});

	it("maven: a -jre classifier falls back to the base version's tag", async () => {
		const metadata = `<metadata><versioning><release>3.17.0-jre</release>
			<versions><version>3.16.0</version><version>3.17.0-jre</version></versions></versioning></metadata>`;
		const { impl } = deps({
			text: {
				"https://repo1.maven.org/maven2/com/google/guava/guava/maven-metadata.xml": metadata,
				"https://repo1.maven.org/maven2/com/google/guava/guava/3.17.0-jre/guava-3.17.0-jre.pom": MAVEN_POM,
			},
			refs: { "https://github.com/google/guava": { tags: ["v3.17.0"], branches: [] } },
		});
		const result = await resolvePackageRepo(
			{ package: "com.google.guava:guava", source: "maven", version: "3.17.0-jre" },
			impl,
		);
		assert.equal(result.repos[0]?.ref, "v3.17.0");
	});

	it("nuget: lowercases the id, reads the nuspec repository, and the plain tag", async () => {
		const { impl, requested } = deps({
			json: { "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json": NUGET_INDEX },
			text: {
				"https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/newtonsoft.json.nuspec": NUGET_NUSPEC,
			},
			refs: { "https://github.com/JamesNK/Newtonsoft.Json": { tags: ["13.0.3"], branches: [] } },
		});
		const result = await resolvePackageRepo(
			{ package: "Newtonsoft.Json", source: "nuget", version: "13.0.3" },
			impl,
		);
		assert.equal(result.version, "13.0.3");
		assert.equal(result.repos[0]?.url, "https://github.com/JamesNK/Newtonsoft.Json");
		assert.equal(result.repos[0]?.via, "nuget-nuspec");
		assert.equal(result.repos[0]?.ref, "13.0.3");
		assert.ok(requested[0]?.includes("/newtonsoft.json/index.json"));
	});

	it("zig: reads the zpm git repo, and says the index has no releases", async () => {
		const { impl } = deps({
			json: { "https://zig.pm/api/packages": ZPM },
			refs: {
				"https://github.com/BanchouBoo/accord": { tags: [], branches: [] },
				"https://github.com/someone/accord": { tags: [], branches: [] },
			},
		});
		const result = await resolvePackageRepo({ package: "BanchouBoo/accord", source: "zig", version: "0.1.0" }, impl);
		assert.equal(result.repos[0]?.url, "https://github.com/BanchouBoo/accord");
		assert.equal(result.repos[0]?.via, "zpm-index");
		assert.deepEqual(result.repos[0]?.refCandidates, ["v0.1.0", "0.1.0"]);
		assert.match(result.warnings.join("\n"), /zpm lists git repos, not releases/);
		assert.equal(cloneTarget(result)?.url, "https://github.com/BanchouBoo/accord");
	});

	it("rejects an unknown source before any request", async () => {
		const { impl, requested } = deps({});
		await assert.rejects(resolvePackageRepo({ package: "x", source: "conda" as never }, impl), /unknown source: conda/);
		assert.deepEqual(requested, []);
	});

	it("rejects a name the source cannot address", async () => {
		const { impl } = deps({});
		await assert.rejects(resolvePackageRepo({ package: "unscoped", source: "jsr" }, impl), /@scope\/name/);
		await assert.rejects(resolvePackageRepo({ package: "noslash", source: "dockerhub" }, impl), /owner\/name/);
	});
});
