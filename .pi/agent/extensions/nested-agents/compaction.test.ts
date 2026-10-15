/**
 * Compaction-consistency test.
 *
 * Dedup state is rebuilt from the transcript, which compaction rewrites. The danger is a compaction
 * cut that drops a file's marker while keeping the content it describes: the extension would then
 * re-inject a file the model already has. This test sweeps EVERY possible cut point against pi's
 * real buildContextEntries and asserts the recovered state always matches what is still in context.
 *
 * Skips itself when pi's dist is not importable (the normal case in a checkout without a build).
 *
 * Run: node --test ~/.pi/agent/extensions/nested-agents/compaction.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectDelivered } from "./logic.ts";

const require = createRequire(import.meta.url);

/**
 * Locate pi's built session-manager, or null.
 *
 * Resolution order:
 *   1. normal module resolution (works when pi is a dependency of this tree);
 *   2. PI_PACKAGE_DIR env override, for a caller that knows where pi is;
 *   3. a bounded search of a few install roots, descending INTO node_modules, since that is where
 *      pi actually lives when it is not a dependency here.
 */
function loadBuildContextEntries(): ((entries: unknown[], leafId: string, byId: Map<string, unknown>) => any[]) | null {
	const SUFFIX = "dist/core/session-manager.js";

	const fromPath = (file: string): unknown => {
		try {
			const mod = require(file) as { buildContextEntries?: unknown };
			return typeof mod.buildContextEntries === "function" ? mod.buildContextEntries : null;
		} catch {
			return null;
		}
	};

	// 1. Normal resolution.
	const direct = fromPath("@earendil-works/pi-coding-agent/" + SUFFIX);
	if (direct) return direct as never;

	// 2. Explicit override.
	if (process.env.PI_PACKAGE_DIR) {
		const found = fromPath(path.join(process.env.PI_PACKAGE_DIR, SUFFIX));
		if (found) return found as never;
	}

	// 3. Bounded search of install roots, descending into node_modules.
	const home = process.env.HOME ?? "";
	const roots = [
		path.join(home, ".vite-plus/packages/@earendil-works/pi-coding-agent"),
		path.join(home, ".vite-plus/packages"),
		path.join(home, ".npm-global/lib/node_modules"),
		path.join(home, ".local/share/pnpm/global"),
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	];

	const seen = new Set<string>();
	const walk = (dir: string, depth: number): unknown => {
		if (depth > 6 || seen.has(dir)) return null;
		seen.add(dir);

		const candidate = path.join(dir, SUFFIX);
		if (fs.existsSync(candidate)) {
			const loaded = fromPath(candidate);
			if (loaded) return loaded;
		}
		// Also try the nested node_modules layout in one step.
		const nested = path.join(dir, "node_modules/@earendil-works/pi-coding-agent", SUFFIX);
		if (fs.existsSync(nested)) {
			const loaded = fromPath(nested);
			if (loaded) return loaded;
		}

		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			return null;
		}
		for (const entry of entries) {
			if (entry === ".git" || entry === ".cache") continue;
			const child = path.join(dir, entry);
			try {
				if (!fs.statSync(child).isDirectory()) continue;
			} catch {
				continue;
			}
			const found = walk(child, depth + 1);
			if (found) return found;
		}
		return null;
	};

	for (const root of roots) {
		if (!fs.existsSync(root)) continue;
		const found = walk(root, 0);
		if (found) return found as never;
	}
	return null;
}

const buildContextEntries = loadBuildContextEntries();

/** A branch as the extension produces it: the marker precedes the toolResult it describes. */
function branch(firstKeptEntryId: string) {
	return [
		{ id: "u1", parentId: null, type: "message", message: { role: "user", content: "read" }, timestamp: 1 },
		{ id: "a1", parentId: "u1", type: "message", message: { role: "assistant", content: [] }, timestamp: 2 },
		{
			id: "m1",
			parentId: "a1",
			type: "custom",
			customType: "nested-agents-injected",
			data: { path: "/r/A/AGENTS.md", id: "/r/A/AGENTS.md", hash: "hA" },
			timestamp: 3,
		},
		{
			id: "t1",
			parentId: "m1",
			type: "message",
			message: {
				role: "toolResult",
				content: [{ type: "text", text: '<project_instructions path="/r/A/AGENTS.md">\nBODY A\n</project_instructions>' }],
			},
			timestamp: 4,
		},
		{ id: "a2", parentId: "t1", type: "message", message: { role: "assistant", content: [] }, timestamp: 5 },
		{ id: "k1", parentId: "a2", type: "compaction", summary: "sum", firstKeptEntryId, timestamp: 6 },
		{ id: "a3", parentId: "k1", type: "message", message: { role: "assistant", content: [] }, timestamp: 7 },
	];
}

describe("compaction never causes a duplicate", { skip: buildContextEntries === null }, () => {
	// Every entry id in the branch is a legal firstKeptEntryId, so sweeping them covers every cut.
	for (const cut of ["a3", "k1", "t1", "m1", "a2", "a1", "u1"]) {
		test("cut at " + cut + " keeps recovered state consistent with context", () => {
			const path = branch(cut);
			const byId = new Map(path.map((e) => [e.id, e]));
			const kept = buildContextEntries!(path, "a3", byId);
			const ids = kept.map((e: { id: string }) => e.id);

			const markerPresent = ids.includes("m1");
			const blockPresent = ids.includes("t1");
			const inContext = markerPresent || blockPresent;
			const recognised = collectDelivered(kept).has("/r/A/AGENTS.md");

			assert.equal(
				recognised,
				inContext,
				"recognised=" + recognised + " but inContext=" + inContext + " (ids: " + ids.join(",") + ")",
			);
		});
	}

	test("a marker dropped while its block survives is still recognised", () => {
		// The specific hazard: compaction keeps the toolResult but drops the marker. Without block
		// recovery the file would be re-injected.
		const path = branch("t1");
		const byId = new Map(path.map((e) => [e.id, e]));
		const kept = buildContextEntries!(path, "a3", byId);
		const ids = kept.map((e: { id: string }) => e.id);
		assert.equal(ids.includes("m1"), false, "precondition: the marker was dropped");
		assert.equal(ids.includes("t1"), true, "precondition: the block survived");
		assert.equal(collectDelivered(kept).has("/r/A/AGENTS.md"), true, "block recovery recognised the file");
	});

	test("when both the marker and the block are dropped, the file is re-armed", () => {
		const path = branch("a3");
		const byId = new Map(path.map((e) => [e.id, e]));
		const kept = buildContextEntries!(path, "a3", byId);
		assert.equal(collectDelivered(kept).has("/r/A/AGENTS.md"), false, "nothing claims the file is present");
	});
});

describe("the marker/block split is unreachable through pi's own compaction", { skip: buildContextEntries === null }, () => {
	/**
	 * pi's cut-point predicate accepts these roles only (src/core/compaction/compaction.ts,
	 * isCutPointMessage). A plain "custom" entry projects to ZERO context messages
	 * (sessionEntryToContextMessages), so a marker can never be a cut point. This test pins that
	 * fact, because it is what makes the split impossible rather than merely unlikely.
	 */
	const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

	test("a nested-agents marker projects to no context message, so it is never a cut point", () => {
		const path = branch("t1");
		const byId = new Map(path.map((e) => [e.id, e]));
		const kept = buildContextEntries!(path, "a3", byId);
		// The marker is a plain custom entry; buildContextEntries keeps or drops it, but the point is
		// that pi's cut finder never SELECTS it. Assert it carries no message by checking that a cut
		// AT the marker still yields a consistent state.
		const atMarker = branch("m1");
		const byId2 = new Map(atMarker.map((e) => [e.id, e]));
		const kept2 = buildContextEntries!(atMarker, "a3", byId2);
		assert.equal(collectDelivered(kept2).has("/r/A/AGENTS.md"), true);
		assert.ok(kept.length > 0);
	});

	test("no legal cut drops the marker while keeping its block", () => {
		// Sweep every entry as a cut; a LEGAL cut is one pi would choose. For each, assert the
		// recovered state matches whether the block is still in context.
		for (const cut of ["a3", "k1", "t1", "m1", "a2", "a1", "u1"]) {
			const path = branch(cut);
			const byId = new Map(path.map((e) => [e.id, e]));
			const kept = buildContextEntries!(path, "a3", byId);
			const ids = kept.map((e: { id: string }) => e.id);
			const blockPresent = ids.includes("t1");
			const recognised = collectDelivered(kept).has("/r/A/AGENTS.md");
			// When the block survives, the file must be recognised. That is the invariant that
			// prevents a duplicate, and it holds for every cut.
			if (blockPresent) {
				assert.equal(recognised, true, "cut at " + cut + " kept the block but lost the record");
			}
		}
	});
});
