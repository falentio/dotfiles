/**
 * Pure logic for the nested-agents extension. No pi imports, no side effects beyond reading the
 * filesystem through injected paths, so every rule here is unit-testable in isolation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { CONTEXT_FILE_CANDIDATES, ENTRY_TYPE, PRUNE_DIRS } from "./config.ts";

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
