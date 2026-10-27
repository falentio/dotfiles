import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONTEXT_FILE_CANDIDATES,
	ENTRY_TYPE,
	PRUNE_DIRS,
	TRIGGER_TOOLS,
} from "./config.ts";
import {
	canonicalIdentity,
	deliveredFromContent,
	pathFromInput,
	chainForInput,
	collectDelivered,
	contextFileIn,
	governingChain,
	hashContent,
	renderInstructions,
	selectDeliveries,
} from "./logic.ts";

let root: string;

function write(rel: string, body: string): string {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
	return abs;
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "nested-agents-test-"));
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	write("AGENTS.md", "ROOT RULES");
	write("packages/AGENTS.md", "PACKAGES RULES");
	write("packages/api/AGENTS.md", "API RULES");
	write("packages/api/handler.ts", "export const h = 1;");
	write("src/thing.ts", "export const t = 1;");
	write("deep/a/b/c/AGENTS.md", "DEEP RULES");
	write("deep/a/b/c/file.ts", "export const d = 1;");
	write("pruned/node_modules/pkg/AGENTS.md", "VENDOR RULES");
	write("pruned/node_modules/pkg/file.ts", "export const v = 1;");
	write("override/AGENTS.md", "PLAIN");
	write("override/AGENTS.override.md", "OVERRIDE WINS");
	write("override/file.ts", "export const o = 1;");
	write("claudeonly/CLAUDE.md", "CLAUDE RULES");
	write("claudeonly/file.ts", "export const c = 1;");

	write("rust/proj/target/debug/AGENTS.md", "RUST TARGET");
	write("rust/proj/src/AGENTS.md", "RUST SRC");
	write("haskell/proj/dist-newstyle/AGENTS.md", "HASKELL DIST");
	write("elixir/proj/_build/AGENTS.md", "ELIXIR BUILD");
	write("elixir/proj/deps/AGENTS.md", "ELIXIR DEPS");
	write("elixir/proj/lib/AGENTS.md", "ELIXIR LIB IS SOURCE");
	write("zig/proj/zig-out/AGENTS.md", "ZIG OUT");
	write("python/proj/__pycache__/AGENTS.md", "PYCACHE");
	write("python/proj/.venv/lib/AGENTS.md", "VENV");
	write("jvm/proj/.gradle/AGENTS.md", "GRADLE");
	write("next/proj/.next/AGENTS.md", "NEXT");
	write("nuxt/proj/.output/AGENTS.md", "NUXT OUTPUT");
	write("svelte/proj/.svelte-kit/AGENTS.md", "SVELTEKIT");
	write("astro/proj/.astro/AGENTS.md", "ASTRO");
	write("angular/proj/.angular/AGENTS.md", "ANGULAR");
	write("nx/proj/.nx/AGENTS.md", "NX");
	write("vite/proj/.vite/AGENTS.md", "VITE");
	write("expo/proj/.expo/AGENTS.md", "EXPO");
	write("storybook/proj/storybook-static/AGENTS.md", "STORYBOOK");
	write("umi/proj/.umi/AGENTS.md", "UMI");
	write("docusaurus/proj/.docusaurus/AGENTS.md", "DOCUSAURUS");
	write("fresh/proj/_fresh/AGENTS.md", "FRESH");
	write("serverless/proj/.wrangler/AGENTS.md", "WRANGLER");
	write("serverless/proj/.sst/AGENTS.md", "SST");
	write("terraform/proj/.terraform/AGENTS.md", "TERRAFORM");
	write("dart/proj/.dart_tool/AGENTS.md", "DART");
	write("apple/proj/DerivedData/AGENTS.md", "DERIVED DATA");
	write("vcs/proj/.git/AGENTS.md", "GIT DIR");
	write("control/lib/AGENTS.md", "LIB IS SOURCE");
	write("control/public/AGENTS.md", "PUBLIC IS SOURCE");
	write("control/assets/AGENTS.md", "ASSETS IS SOURCE");
	write("control/static/AGENTS.md", "STATIC IS SOURCE");
	write("control/bin/AGENTS.md", "BIN IS SOURCE");
	write("control/pkg/AGENTS.md", "PKG IS SOURCE");
	write("control/docs/AGENTS.md", "DOCS IS SOURCE");
	write("control/scripts/AGENTS.md", "SCRIPTS IS SOURCE");
	write("control/examples/AGENTS.md", "EXAMPLES IS SOURCE");
	write("control/packages/AGENTS.md", "PACKAGES IS SOURCE");
	write("control/.storybook/AGENTS.md", "STORYBOOK CONFIG IS SOURCE");
	write("control/vendor/AGENTS.md", "VENDOR IS PRUNED");
	write("control/out/AGENTS.md", "OUT IS PRUNED");
	write("control/obj/AGENTS.md", "OBJ IS PRUNED");
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("contextFileIn", () => {
	test("returns the first candidate present", () => {
		assert.equal(contextFileIn(path.join(root, "packages")), path.join(root, "packages/AGENTS.md"));
	});

	test("AGENTS.override.md beats AGENTS.md in the same directory", () => {
		assert.equal(
			contextFileIn(path.join(root, "override")),
			path.join(root, "override/AGENTS.override.md"),
		);
	});

	test("falls through to CLAUDE.md when no AGENTS.md exists", () => {
		assert.equal(contextFileIn(path.join(root, "claudeonly")), path.join(root, "claudeonly/CLAUDE.md"));
	});

	test("returns null when the directory has no context file", () => {
		assert.equal(contextFileIn(path.join(root, "src")), null);
	});

	test("candidate list matches pi's own precedence", () => {
		assert.deepEqual([...CONTEXT_FILE_CANDIDATES], [
			"AGENTS.override.md",
			"AGENTS.md",
			"AGENTS.MD",
			"CLAUDE.md",
			"CLAUDE.MD",
		]);
	});
});

describe("governingChain", () => {
	test("collects the whole chain below cwd, outermost first", () => {
		assert.deepEqual(governingChain(path.join(root, "packages/api/handler.ts"), root), [
			path.join(root, "packages/AGENTS.md"),
			path.join(root, "packages/api/AGENTS.md"),
		]);
	});

	test("returns nothing for a file directly under cwd (ancestor files already loaded)", () => {
		assert.deepEqual(governingChain(path.join(root, "src/thing.ts"), root), []);
	});

	test("returns nothing for cwd's own context file", () => {
		assert.deepEqual(governingChain(path.join(root, "AGENTS.md"), root), []);
	});

	test("returns nothing for a file above cwd", () => {
		assert.deepEqual(governingChain(path.join(root, "AGENTS.md"), path.join(root, "packages")), []);
	});

	test("finds a deep file across several levels", () => {
		assert.deepEqual(governingChain(path.join(root, "deep/a/b/c/file.ts"), root), [
			path.join(root, "deep/a/b/c/AGENTS.md"),
		]);
	});

	test("rejects a file inside a pruned subtree, even a nested one", () => {
		assert.deepEqual(governingChain(path.join(root, "pruned/node_modules/pkg/file.ts"), root), []);
		assert.deepEqual(governingChain(path.join(root, "pruned/node_modules/pkg/AGENTS.md"), root), []);
	});

	test("a nearer file is preferred over a farther one in the chain, but both are kept", () => {
		const chain = governingChain(path.join(root, "packages/api/handler.ts"), root);
		assert.ok(chain[0].endsWith("packages/AGENTS.md"));
		assert.ok(chain[1].endsWith("packages/api/AGENTS.md"));
	});
});

describe("chainForInput", () => {
	test("resolves a relative path against cwd", () => {
		assert.deepEqual(chainForInput({ path: "packages/api/handler.ts" }, root), [
			path.join(root, "packages/AGENTS.md"),
			path.join(root, "packages/api/AGENTS.md"),
		]);
	});

	test("resolves an absolute path", () => {
		assert.deepEqual(chainForInput({ path: path.join(root, "packages/api/handler.ts") }, root), [
			path.join(root, "packages/AGENTS.md"),
			path.join(root, "packages/api/AGENTS.md"),
		]);
	});

	test("returns [] for a non-string path (bash tool_result shape)", () => {
		assert.deepEqual(chainForInput({ command: "cat foo.ts" }, root), []);
	});

	test("returns [] for an empty path", () => {
		assert.deepEqual(chainForInput({ path: "" }, root), []);
	});

	test("accepts the file_path alias, as pi's own renderers do", () => {
		assert.deepEqual(chainForInput({ file_path: "packages/api/handler.ts" }, root), [
			path.join(root, "packages/AGENTS.md"),
			path.join(root, "packages/api/AGENTS.md"),
		]);
	});

	test("path wins over file_path when both are present", () => {
		assert.deepEqual(chainForInput({ path: "packages/api/handler.ts", file_path: "src/thing.ts" }, root), [
			path.join(root, "packages/AGENTS.md"),
			path.join(root, "packages/api/AGENTS.md"),
		]);
	});
});

describe("pathFromInput", () => {
	test("reads path", () => {
		assert.equal(pathFromInput({ path: "/a/b" }), "/a/b");
	});

	test("falls back to file_path", () => {
		assert.equal(pathFromInput({ file_path: "/a/b" }), "/a/b");
	});

	test("prefers path when both are present", () => {
		assert.equal(pathFromInput({ path: "/first", file_path: "/second" }), "/first");
	});

	test("returns null for a missing, empty, or non-string path", () => {
		assert.equal(pathFromInput({}), null);
		assert.equal(pathFromInput({ path: "" }), null);
		assert.equal(pathFromInput({ path: 42 }), null);
		assert.equal(pathFromInput({ file_path: null }), null);
	});
});

describe("TRIGGER_TOOLS", () => {
	test("includes read, write, and edit", () => {
		assert.deepEqual([...TRIGGER_TOOLS].sort(), ["edit", "read", "write"]);
	});

	test("excludes bash (no path in its input)", () => {
		assert.equal(TRIGGER_TOOLS.has("bash"), false);
	});
});

describe("selectDeliveries", () => {
	test("delivers every governing file on first sight", () => {
		const fresh = selectDeliveries({ path: "packages/api/handler.ts" }, root, new Map());
		assert.equal(fresh.length, 2);
		assert.ok(fresh[0].body.includes("PACKAGES RULES"));
		assert.ok(fresh[1].body.includes("API RULES"));
	});

	test("delivers nothing when all hashes are already known", () => {
		const first = selectDeliveries({ path: "packages/api/handler.ts" }, root, new Map());
		const delivered = new Map(first.map((d) => [d.path, d.hash]));
		assert.deepEqual(selectDeliveries({ path: "packages/api/handler.ts" }, root, delivered), []);
	});

	test("re-delivers only the changed file, not its unchanged sibling", () => {
		const first = selectDeliveries({ path: "packages/api/handler.ts" }, root, new Map());
		const delivered = new Map(first.map((d) => [d.path, d.hash]));

		write("packages/api/AGENTS.md", "API RULES EDITED");
		const fresh = selectDeliveries({ path: "packages/api/handler.ts" }, root, delivered);

		assert.equal(fresh.length, 1);
		assert.ok(fresh[0].path.endsWith("packages/api/AGENTS.md"));
		assert.ok(fresh[0].body.includes("EDITED"));

		write("packages/api/AGENTS.md", "API RULES");
	});

	test("delivers nothing for a file with no governing context", () => {
		assert.deepEqual(selectDeliveries({ path: "src/thing.ts" }, root, new Map()), []);
	});

	test("hash is stable for identical content and differs on change", () => {
		assert.equal(hashContent("same"), hashContent("same"));
		assert.notEqual(hashContent("a"), hashContent("b"));
	});
});

describe("renderInstructions", () => {
	test("wraps each delivery in a project_instructions block with its path", () => {
		const text = renderInstructions([{ path: "/x/AGENTS.md", body: "RULES", hash: "h" }]);
		assert.ok(text.includes('<project_instructions path="/x/AGENTS.md">'));
		assert.ok(text.includes("RULES"));
		assert.ok(text.includes("</project_instructions>"));
	});

	test("concatenates multiple deliveries", () => {
		const text = renderInstructions([
			{ path: "/a/AGENTS.md", body: "A", hash: "1" },
			{ path: "/b/AGENTS.md", body: "B", hash: "2" },
		]);
		assert.equal((text.match(/project_instructions/g) ?? []).length, 4);
	});

	test("empty input renders empty text", () => {
		assert.equal(renderInstructions([]), "");
	});
});

describe("collectDelivered", () => {
	test("rebuilds the map from our custom entries", () => {
		const entries = [
			{ type: "message", message: {} },
			{ type: "custom", customType: ENTRY_TYPE, data: { path: "/a/AGENTS.md", hash: "h1" } },
			{ type: "custom", customType: "other-extension", data: { path: "/x", hash: "hx" } },
			{ type: "custom", customType: ENTRY_TYPE, data: { path: "/b/AGENTS.md", hash: "h2" } },
		];
		const delivered = collectDelivered(entries);
		assert.equal(delivered.size, 2);
		assert.equal(delivered.get("/a/AGENTS.md"), "h1");
		assert.equal(delivered.get("/b/AGENTS.md"), "h2");
		assert.equal(delivered.has("/x"), false);
	});

	test("ignores entries with a malformed data payload", () => {
		const entries = [
			{ type: "custom", customType: ENTRY_TYPE, data: { path: "/a" } },
			{ type: "custom", customType: ENTRY_TYPE, data: null },
			{ type: "custom", customType: ENTRY_TYPE },
		];
		assert.equal(collectDelivered(entries).size, 0);
	});

	test("ignores non-object entries", () => {
		assert.equal(collectDelivered([null, "x", 42, undefined]).size, 0);
	});

	test("empty transcript yields an empty map", () => {
		assert.equal(collectDelivered([]).size, 0);
	});
});

describe("PRUNE_DIRS", () => {
	const prunedCases: Array<[string, string]> = [
		["rust target", "rust/proj/target/debug/AGENTS.md"],
		["haskell dist-newstyle", "haskell/proj/dist-newstyle/AGENTS.md"],
		["elixir _build", "elixir/proj/_build/AGENTS.md"],
		["elixir deps", "elixir/proj/deps/AGENTS.md"],
		["zig zig-out", "zig/proj/zig-out/AGENTS.md"],
		["python __pycache__", "python/proj/__pycache__/AGENTS.md"],
		["python .venv", "python/proj/.venv/lib/AGENTS.md"],
		["jvm .gradle", "jvm/proj/.gradle/AGENTS.md"],
		["next .next", "next/proj/.next/AGENTS.md"],
		["nuxt .output", "nuxt/proj/.output/AGENTS.md"],
		["sveltekit .svelte-kit", "svelte/proj/.svelte-kit/AGENTS.md"],
		["astro .astro", "astro/proj/.astro/AGENTS.md"],
		["angular .angular", "angular/proj/.angular/AGENTS.md"],
		["nx .nx", "nx/proj/.nx/AGENTS.md"],
		["vite .vite", "vite/proj/.vite/AGENTS.md"],
		["expo .expo", "expo/proj/.expo/AGENTS.md"],
		["storybook storybook-static", "storybook/proj/storybook-static/AGENTS.md"],
		["umi .umi", "umi/proj/.umi/AGENTS.md"],
		["docusaurus .docusaurus", "docusaurus/proj/.docusaurus/AGENTS.md"],
		["fresh _fresh", "fresh/proj/_fresh/AGENTS.md"],
		["cloudflare .wrangler", "serverless/proj/.wrangler/AGENTS.md"],
		["sst .sst", "serverless/proj/.sst/AGENTS.md"],
		["terraform .terraform", "terraform/proj/.terraform/AGENTS.md"],
		["dart .dart_tool", "dart/proj/.dart_tool/AGENTS.md"],
		["apple DerivedData", "apple/proj/DerivedData/AGENTS.md"],
		["vcs .git", "vcs/proj/.git/AGENTS.md"],
		["generic vendor", "control/vendor/AGENTS.md"],
		["generic out", "control/out/AGENTS.md"],
		["generic obj", "control/obj/AGENTS.md"],
	];

	for (const [label, rel] of prunedCases) {
		test("prunes " + label, () => {
			assert.deepEqual(governingChain(path.join(root, rel), root), []);
		});
	}

	const sourceCases = ["lib", "public", "assets", "static", "bin", "pkg", "docs", "scripts", "examples", "packages", ".storybook"];

	for (const name of sourceCases) {
		test("does NOT prune source directory " + name, () => {
			assert.deepEqual(governingChain(path.join(root, "control", name, "AGENTS.md"), root), [
				path.join(root, "control", name, "AGENTS.md"),
			]);
		});
	}

	test("a source file next to a pruned subtree still resolves", () => {
		assert.deepEqual(governingChain(path.join(root, "rust/proj/src/AGENTS.md"), root), [
			path.join(root, "rust/proj/src/AGENTS.md"),
		]);
	});

	test("elixir lib is source even though elixir deps is pruned", () => {
		assert.deepEqual(governingChain(path.join(root, "elixir/proj/lib/AGENTS.md"), root), [
			path.join(root, "elixir/proj/lib/AGENTS.md"),
		]);
	});

	test("every group contributes at least one name and the set is derived from them", () => {
		assert.ok(PRUNE_DIRS.size > 50, "the expanded list is large");
		assert.ok(PRUNE_DIRS.has("node_modules"));
		assert.ok(PRUNE_DIRS.has("target"));
		assert.ok(PRUNE_DIRS.has("_build"));
		assert.ok(PRUNE_DIRS.has(".next"));
		assert.ok(PRUNE_DIRS.has(".nuxt"));
		assert.ok(!PRUNE_DIRS.has("lib"));
		assert.ok(!PRUNE_DIRS.has("packages"));
	});
});

describe("canonicalIdentity", () => {
	test("a symlinked file shares identity with its target", () => {
		const real = write("identity/real/AGENTS.md", "RULES");
		const link = path.join(root, "identity/link/AGENTS.md");
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(real, link);
		assert.equal(canonicalIdentity(link), canonicalIdentity(real));
	});

	test("distinct files have distinct identities", () => {
		const a = write("identity/a/AGENTS.md", "A");
		const b = write("identity/b/AGENTS.md", "B");
		assert.notEqual(canonicalIdentity(a), canonicalIdentity(b));
	});

	test("a missing path still yields a stable key", () => {
		const gone = path.join(root, "identity/gone/AGENTS.md");
		assert.equal(canonicalIdentity(gone), canonicalIdentity(gone));
	});
});

describe("deliveredFromContent", () => {
	test("recovers path and hash from an injected block", () => {
		const body = "API RULES";
		const content = [
			{ type: "text", text: 'file\n\n<project_instructions path="/x/AGENTS.md">\n' + body + "\n</project_instructions>" },
		];
		const found = deliveredFromContent(content);
		assert.equal(found.length, 1);
		assert.equal(found[0].path, "/x/AGENTS.md");
		assert.equal(found[0].hash, hashContent(body));
	});

	test("recovers several blocks from one result", () => {
		const content = [
			{
				type: "text",
				text:
					'<project_instructions path="/a">\nA\n</project_instructions>' +
					'<project_instructions path="/b">\nB\n</project_instructions>',
			},
		];
		assert.deepEqual(
			deliveredFromContent(content).map((d) => d.path),
			["/a", "/b"],
		);
	});

	test("ignores content with no block, and non-array content", () => {
		assert.deepEqual(deliveredFromContent([{ type: "text", text: "plain" }]), []);
		assert.deepEqual(deliveredFromContent("a string"), []);
		assert.deepEqual(deliveredFromContent(undefined), []);
	});
});

describe("collectDelivered identity and block recovery", () => {
	test("keys marker entries by canonical identity, not the stored path", () => {
		const real = write("collect/real/AGENTS.md", "RULES");
		const link = path.join(root, "collect/link/AGENTS.md");
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.symlinkSync(real, link);
		const delivered = collectDelivered([
			{ type: "custom", customType: ENTRY_TYPE, data: { path: link, id: link, hash: "h" } },
		]);
		assert.equal(delivered.get(canonicalIdentity(real)), "h");
		assert.equal(delivered.get(link), undefined, "the raw path is not the key");
	});

	test("recovers records from a toolResult block when no marker exists", () => {
		const delivered = collectDelivered([
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: '<project_instructions path="/x/AGENTS.md">\nRULES\n</project_instructions>' }],
				},
			},
		]);
		assert.equal(delivered.size, 1);
		assert.equal(delivered.get(canonicalIdentity("/x/AGENTS.md")), hashContent("RULES"));
	});

	test("ignores toolResult messages that carry no block", () => {
		const delivered = collectDelivered([
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "plain output" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
		]);
		assert.equal(delivered.size, 0);
	});

	test("a marker and a block for the same file agree, and do not double count", () => {
		const body = "RULES";
		const delivered = collectDelivered([
			{ type: "custom", customType: ENTRY_TYPE, data: { path: "/x/AGENTS.md", id: "/x/AGENTS.md", hash: hashContent(body) } },
			{
				type: "message",
				message: {
					role: "toolResult",
					content: [{ type: "text", text: '<project_instructions path="/x/AGENTS.md">\n' + body + "\n</project_instructions>" }],
				},
			},
		]);
		assert.equal(delivered.size, 1);
	});
});

describe("one batch never repeats an identity", () => {
	test("a parent and child linking to the same file deliver it once", () => {
		const shared = write("batch/shared.md", "SHARED RULES");
		const parent = path.join(root, "batch/pkg");
		const child = path.join(root, "batch/pkg/sub");
		fs.mkdirSync(parent, { recursive: true });
		fs.mkdirSync(child, { recursive: true });
		fs.symlinkSync(shared, path.join(parent, "AGENTS.md"));
		fs.symlinkSync(shared, path.join(child, "AGENTS.md"));
		write("batch/pkg/sub/file.ts", "export const x = 1;");

		const chain = chainForInput({ path: "batch/pkg/sub/file.ts" }, root);
		assert.equal(chain.length, 2, "the chain really has two entries");
		assert.equal(canonicalIdentity(chain[0]), canonicalIdentity(chain[1]), "and they share one identity");

		const fresh = selectDeliveries({ path: "batch/pkg/sub/file.ts" }, root, new Map());
		assert.equal(fresh.length, 1, "delivered once, not once per chain entry");
		assert.equal(canonicalIdentity(fresh[0].path), canonicalIdentity(shared));
	});

	test("distinct files in one chain are still all delivered", () => {
		const fresh = selectDeliveries({ path: "packages/api/handler.ts" }, root, new Map());
		assert.equal(fresh.length, 2, "the batch dedupe must not swallow genuinely distinct files");
	});
});
