/**
 * Pure logic for the nested-agents extension. No pi imports, no side effects beyond reading the
 * filesystem through injected paths, so every rule here is unit-testable in isolation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

/** Filename precedence, matching pi's own context-file resolution. First hit wins per directory. */
export const CONTEXT_FILE_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

/**
 * Directories whose contents never carry project instructions, grouped by the ecosystem that
 * produces them. The list is derived from this table so each name keeps its reason.
 *
 * The prune rule is a hard stop: a file anywhere inside a pruned subtree gets NO context, not just
 * the pruned directory's own instructions. A false positive therefore breaks injection for a whole
 * source tree, so this list holds only names that are essentially never a source directory.
 *
 * Deliberately absent, because they are real source in ordinary repos (counts are tracked files
 * observed across five local repos):
 *   lib (701), public (287), assets (200), static (17), pkg (19), bin (9), docs (1051),
 *   scripts (462), examples (2382), packages, www, tmp, out, log, logs, src, test, tests.
 * Also absent: .storybook, .vitepress, .meteor, .claude, .pi, .github, and any other directory that
 * holds configuration or source alongside generated files.
 */
const PRUNE_GROUPS = {
	vcs: [".git", ".hg", ".svn"],
	// Package managers and vendored dependencies.
	dependencies: [
		"node_modules",
		"bower_components",
		".pnpm-store",
		".yarn",
		".bun",
		"vendor",
		"Pods",
		"Carthage",
		".bundle",
	],
	// Generic build output.
	build: ["dist", "build", "out", "obj", "coverage", ".nyc_output"],
	// Rust (Cargo).
	rust: ["target"],
	haskell: ["dist-newstyle", ".stack-work"],
	// Go. Go dependencies live in the module cache, not the repo, so only vendor applies (above).
	go: [],
	// Elixir and Erlang.
	elixir: ["_build", "deps", "cover", ".elixir_ls"],
	// Zig.
	zig: ["zig-out", ".zig-cache"],
	// Python.
	python: [
		"__pycache__",
		".venv",
		"venv",
		".eggs",
		".tox",
		".mypy_cache",
		".pytest_cache",
		".ruff_cache",
		"htmlcov",
	],
	// JVM, Android, and Gradle.
	jvm: [".gradle", "build"],
	// Apple platforms.
	apple: ["DerivedData", ".swiftpm", "build"],
	// Dart and Flutter.
	dart: [".dart_tool", ".pub-cache"],
	// Next.js.
	next: [".next", ".vercel", ".turbo", ".swc"],
	// Nuxt and Nitro.
	nuxt: [".nuxt", ".output", ".nitro", ".data"],
	// SvelteKit.
	sveltekit: [".svelte-kit"],
	// Astro.
	astro: [".astro"],
	// Angular.
	angular: [".angular"],
	// Nx and Turborepo.
	nx: [".nx"],
	// Vite, Parcel, and the shared bundler caches.
	bundlers: [".vite", ".parcel-cache", ".cache"],
	// Remix, React Router, and other Vite SSR frameworks.
	remix: [".cache"],
	// Expo and React Native.
	reactNative: [".expo"],
	// Storybook.
	storybook: ["storybook-static"],
	// Umi and Dumi.
	umi: [".umi", ".dumi"],
	// Docusaurus.
	docusaurus: [".docusaurus"],
	// Deno Fresh.
	fresh: ["_fresh"],
	// SolidStart.
	solid: [".vinxi"],
	// Static site generators: Jekyll, Eleventy, Hugo, VitePress.
	ssg: ["_site", ".jekyll-cache"],
	// Cloudflare, Netlify, Firebase, Serverless, SST, Amplify, OpenNext.
	serverlessPlatforms: [
		".wrangler",
		".netlify",
		".firebase",
		".serverless",
		".sst",
		".amplify",
		".open-next",
		".wxt",
	],
	// Qwik, Stencil, Redwood, Blitz.
	otherFrameworks: [".qwik", ".stencil", ".redwood", ".blitz"],
	// Infrastructure as code.
	terraform: [".terraform", ".terragrunt-cache"],
} as const;

/**
 * The flat lookup structure, derived from the grouped table above so the two cannot drift.
 */
export const PRUNE_DIRS: ReadonlySet<string> = new Set(Object.values(PRUNE_GROUPS).flat());

/** Transcript entry type used to record what has been delivered. */
export const ENTRY_TYPE = "nested-agents-injected";

export interface DeliveredRecord {
	path: string;
	hash: string;
}

export function hashContent(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The identity of a context file: one file, one key, however it is reached.
 *
 * Dedup must not key on the path string, because the same file is reachable through several logical
 * paths (a symlinked directory, a bind mount, a `..` segment). Canonicalizing to the real path makes
 * those one identity. Falls back to the resolved path when the target is gone, so a deleted file
 * still produces a stable key for its record.
 */
export function canonicalIdentity(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

/** The context file governing `dir`, or null. First candidate that is a readable regular file wins. */
export function contextFileIn(dir: string): string | null {
	for (const name of CONTEXT_FILE_CANDIDATES) {
		const candidate = path.join(dir, name);
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// missing or unreadable: try the next candidate
		}
	}
	return null;
}

/**
 * Context files that govern `abs` and sit STRICTLY BELOW `cwd`, outermost first.
 *
 * Empty when the file is at or above cwd: those files are already in the system prompt, and
 * re-injecting them duplicates context. Stops at a pruned directory name.
 */
export function governingChain(abs: string, cwd: string): string[] {
	const root = path.resolve(cwd);
	const chain: string[] = [];
	let dir = path.dirname(path.resolve(abs));
	while (true) {
		const rel = path.relative(root, dir);
		if (rel === "" || rel.startsWith("..")) break;
		// A file anywhere inside a pruned subtree gets no context: the prune rule must reject the
		// whole path, not just the directory whose basename happens to be pruned.
		if (rel.split(path.sep).some((segment) => PRUNE_DIRS.has(segment))) break;
		const hit = contextFileIn(dir);
		if (hit) chain.push(hit);
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return chain.reverse();
}

/**
 * The path named by a tool input, or null.
 *
 * pi's own tool renderers read `args.file_path ?? args.path`, because models sometimes emit the
 * legacy `file_path` field. Accept both so a read or edit carrying the alias still resolves.
 */
export function pathFromInput(input: Record<string, unknown>): string | null {
	const candidate = input.path ?? input.file_path;
	if (typeof candidate !== "string" || candidate.length === 0) return null;
	return candidate;
}

/** Every governing file for a tool input, or [] when the input names no path. */
export function chainForInput(input: Record<string, unknown>, cwd: string): string[] {
	const raw = pathFromInput(input);
	if (raw === null) return [];
	return governingChain(path.resolve(cwd, raw), cwd);
}

/**
 * Tool names whose results can trigger injection.
 *
 * edit is included: it reads the file through its own fs call, NOT through the read tool, so a model
 * that edits without reading first would otherwise get no context. Verified: with only edit
 * available, the extension injected nothing.
 */
export const TRIGGER_TOOLS = new Set(["read", "write", "edit"]);

export interface Delivery {
	/** The logical path, as the model sees it in the injected block. */
	path: string;
	/** The canonical identity used for dedup. Never rendered. */
	id: string;
	body: string;
	hash: string;
}

/**
 * Which governing files for `input` are new or changed relative to `delivered`, and their content.
 * Pure: reads files, mutates nothing. The caller commits the returned records.
 */
export function selectDeliveries(
	input: Record<string, unknown>,
	cwd: string,
	delivered: ReadonlyMap<string, string>,
): Delivery[] {
	const fresh: Delivery[] = [];
	// Identities claimed by THIS batch. Two chain entries can share one identity when a parent and a
	// child directory each link to the same file, so the batch needs its own dedupe set: checking
	// only `delivered` would emit that file once per entry.
	const claimed = new Set<string>();
	for (const file of chainForInput(input, cwd)) {
		let body: string;
		try {
			body = fs.readFileSync(file, "utf-8");
		} catch {
			continue;
		}
		const hash = hashContent(body);
		const id = canonicalIdentity(file);
		if (claimed.has(id)) continue;
		if (delivered.get(id) === hash) continue;
		claimed.add(id);
		fresh.push({ path: file, id, body, hash });
	}
	return fresh;
}

/** Render the injected block appended to a tool result. */
export function renderInstructions(deliveries: readonly Delivery[]): string {
	return deliveries
		.map(({ path: file, body }) => `\n\n<project_instructions path="${file}">\n${body}\n</project_instructions>`)
		.join("");
}

/** Matches one injected block, capturing its path and body. */
const INJECTED_BLOCK = /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g;

/**
 * Records recoverable from the injected blocks inside a tool result.
 *
 * The block IS the record: if the text is still in context, the model still has those instructions.
 * Reading it back closes the gap a separate marker leaves, because compaction can drop a marker
 * entry while keeping the tool result it describes. Deriving the record from the content means the
 * two cannot disagree.
 */
export function deliveredFromContent(content: unknown): Array<{ path: string; hash: string }> {
	const found: Array<{ path: string; hash: string }> = [];
	if (!Array.isArray(content)) return found;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const text = (part as { text?: unknown }).text;
		if (typeof text !== "string") continue;
		for (const match of text.matchAll(INJECTED_BLOCK)) {
			found.push({ path: match[1], hash: hashContent(match[2]) });
		}
	}
	return found;
}

/**
 * Rebuild the delivered map from transcript entries, keyed by canonical identity.
 *
 * Two sources, deliberately redundant:
 *   1. our custom marker entries, which carry the identity and hash directly;
 *   2. the injected blocks inside tool results, which survive when a marker does not.
 * A file is considered delivered if either source proves it, so a duplicate cannot slip through.
 */
export function collectDelivered(entries: readonly unknown[]): Map<string, string> {
	const delivered = new Map<string, string>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as { type?: string; customType?: string; data?: unknown; message?: unknown };

		if (e.type === "custom" && e.customType === ENTRY_TYPE) {
			const data = e.data as { path?: unknown; id?: unknown; hash?: unknown } | undefined;
			const raw = typeof data?.id === "string" ? data.id : typeof data?.path === "string" ? data.path : null;
			if (raw !== null && typeof data?.hash === "string") delivered.set(canonicalIdentity(raw), data.hash);
			continue;
		}

		if (e.type === "message") {
			const message = e.message as { role?: unknown; content?: unknown } | undefined;
			if (message?.role !== "toolResult") continue;
			for (const { path: file, hash } of deliveredFromContent(message.content)) {
				delivered.set(canonicalIdentity(file), hash);
			}
		}
	}
	return delivered;
}
