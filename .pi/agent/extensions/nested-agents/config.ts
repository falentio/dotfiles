/**
 * Nested-agents settings. This file is the only settings source: no environment
 * variable or other file is read.
 */

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
 *   scripts (462), examples (2382), packages, www, tmp, log, logs, src, test, tests.
 * Also absent: .storybook, .vitepress, .meteor, .claude, .pi, .github, and any other directory that
 * holds configuration or source alongside generated files.
 */
const PRUNE_GROUPS = {
	vcs: [".git", ".hg", ".svn"],
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
	build: ["dist", "build", "out", "obj", "coverage", ".nyc_output"],
	rust: ["target"],
	haskell: ["dist-newstyle", ".stack-work"],
	// Go. Go dependencies live in the module cache, not the repo, so only vendor applies (above).
	go: [],
	elixir: ["_build", "deps", "cover", ".elixir_ls"],
	zig: ["zig-out", ".zig-cache"],
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
	jvm: [".gradle", "build"],
	apple: ["DerivedData", ".swiftpm", "build"],
	dart: [".dart_tool", ".pub-cache"],
	next: [".next", ".vercel", ".turbo", ".swc"],
	nuxt: [".nuxt", ".output", ".nitro", ".data"],
	sveltekit: [".svelte-kit"],
	astro: [".astro"],
	angular: [".angular"],
	nx: [".nx"],
	// Vite, Parcel, and the shared bundler caches.
	bundlers: [".vite", ".parcel-cache", ".cache"],
	// Remix, React Router, and other Vite SSR frameworks.
	remix: [".cache"],
	reactNative: [".expo"],
	storybook: ["storybook-static"],
	umi: [".umi", ".dumi"],
	docusaurus: [".docusaurus"],
	fresh: ["_fresh"],
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
	terraform: [".terraform", ".terragrunt-cache"],
} as const;

/**
 * The flat lookup structure, derived from the grouped table above so the two cannot drift.
 */
export const PRUNE_DIRS: ReadonlySet<string> = new Set(Object.values(PRUNE_GROUPS).flat());

/** Transcript entry type used to record what has been delivered. */
export const ENTRY_TYPE = "nested-agents-injected";

/**
 * Tool names whose results can trigger injection.
 *
 * edit is included: it reads the file through its own fs call, NOT through the read tool, so a model
 * that edits without reading first would otherwise get no context. Verified: with only edit
 * available, the extension injected nothing.
 */
export const TRIGGER_TOOLS = new Set(["read", "write", "edit"]);
