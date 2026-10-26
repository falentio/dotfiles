/**
 * The session registry: one live scout per conversation, serialized, evicted when idle.
 *
 * Pure bookkeeping. Everything that can be decided without a model, a network, or the pi SDK lives
 * here so it can be tested: queue order, the idle clock, the turn deadline, which conversation a
 * request maps to, and which session file to reopen after an eviction. The agent itself is behind
 * `ScoutAdapter`; `agent-session.ts` is the one implementation.
 *
 * A request carries its own identity: the repo, the ref, the model, and the thinking level. The key
 * is derived from all four, so nothing has to be recovered from a side table, and two callers that
 * disagree on any of them get two conversations.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { RepoIdentity } from "./repo-id.ts";

/** The thinking levels pi accepts. Kept here so the registry stays free of SDK imports. */
export type ScoutThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** What a conversation is asked with. */
export type ScoutRequest = {
	repo: RepoIdentity;
	ref?: string;
	model: Model<any>;
	thinkingLevel: ScoutThinking;
	question: string;
};

/** The conversation a request maps to: all four of repo, ref, model, and thinking level. */
export const conversationKey = (request: {
	repo: RepoIdentity;
	ref?: string;
	model: Model<any>;
	thinkingLevel: ScoutThinking;
}): string =>
	[request.repo.key, request.ref ?? "", request.model.provider + "/" + request.model.id, request.thinkingLevel].join("|");

/** What the registry needs from whoever owns the conversations. */
export interface ScoutAdapter {
	/** Open a conversation about `repo`, reading `dir`, replaying `sessionFile` when it exists. */
	open(
		repo: string,
		dir: string,
		sessionFile: string | undefined,
		choice: { model: Model<any>; thinkingLevel: ScoutThinking },
	): Promise<ScoutConversation>;
}

export interface ScoutConversation {
	/** Run one question to completion. Rejects on failure or abort. */
	ask(question: string, signal?: AbortSignal): Promise<string>;
	/** The session file the conversation is recorded to, if any. */
	sessionFile(): string | undefined;
	/** True while this conversation is new and has not answered yet. */
	fresh(): boolean;
	/** Stop the turn in progress, when the implementation can. */
	abort?(): void;
	dispose(): void;
}

/**
 * Where a session file should live, given the conversation key. This is only a starting point: pi
 * names the file it creates and the conversation reports back what it actually wrote, so the
 * registry remembers that path instead. Getting this wrong would start a new file after every
 * eviction, throwing away the cache the eviction is supposed to preserve.
 */
export type SessionFileFor = (key: string) => string;

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface ScoutRegistryOptions {
	/** Clone the tree when it is missing, and verify an existing tree belongs to this repo. */
	checkout: (request: { repo: RepoIdentity; ref?: string }) => Promise<{ dir: string; display: string; warning?: string }>;
	/** Move an existing tree to the requested ref. Throws on failure. */
	refresh: (dir: string, ref?: string) => Promise<void>;
	adapter: ScoutAdapter;
	sessionFileFor: SessionFileFor;
	/** Idle window in ms. A session quiet for this long is evicted. */
	idleMs?: number;
	/** Idle sweep interval in ms. Defaults to a third of `idleMs`, at least 1s. */
	sweepMs?: number;
	/** One turn's ceiling in ms. Defaults to fifteen minutes. */
	turnMs?: number;
	log?: Logger;
	now?: () => number;
	/** Timer seam, so tests drive the clock without waiting. */
	timers?: {
		setInterval(fn: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
}

const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_TURN_MS = 900_000;

type Entry = {
	key: string;
	dir: string;
	/** The conversation file pi actually wrote, remembered for the reopen after an eviction. */
	sessionFile: string | undefined;
	conversation: ScoutConversation;
	/** Questions waiting for the current one, FIFO. */
	queue: Waiter[];
	/** The question running now, so eviction can settle its caller. */
	inFlight: Waiter | undefined;
	busy: boolean;
	/** Set when an idle sweep evicted the entry, so `run` stops using it. */
	evicted: boolean;
	lastUsedAt: number;
	/** Checkout and refresh notes, reported with every answer from this entry. */
	warnings: string[];
};

type Waiter = {
	question: string;
	signal: AbortSignal | undefined;
	resolve: (answer: { report: string; fresh: boolean }) => void;
	reject: (error: Error) => void;
};

export type ScoutResult = {
	report: string;
	/** Checkout the scout read. */
	dir: string;
	/** The conversation file, so a caller can point a later subagent at the same crawl. */
	sessionFile: string | undefined;
	/** True when this turn was the first of a brand-new conversation. */
	fresh: boolean;
	/** Checkout or refresh problems worth printing next to the answer. */
	warnings: string[];
};

export class ScoutRegistry {
	private readonly entries = new Map<string, Entry>();
	/** The file each key's conversation was recorded to, surviving eviction. */
	private readonly sessionFiles = new Map<string, string>();
	/** Keys with work in flight: one ticket per key, so a first run opens one session, not two. */
	private readonly opening = new Map<string, Promise<Entry>>();
	/** Directories with a live conversation, so a second one never resets the tree under it. */
	private readonly owners = new Map<string, Set<string>>();
	private readonly idleMs: number;
	private readonly turnMs: number;
	private readonly log: Logger;
	private readonly now: () => number;
	private readonly timers: NonNullable<ScoutRegistryOptions["timers"]>;
	private readonly sweep: unknown;
	private closed = false;

	private readonly options: ScoutRegistryOptions;

	constructor(options: ScoutRegistryOptions) {
		this.options = options;
		this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		this.turnMs = options.turnMs ?? DEFAULT_TURN_MS;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? { info: () => {}, warn: () => {}, error: () => {} };
		this.timers = options.timers ?? {
			setInterval: (fn, ms) => {
				const handle = setInterval(fn, ms);
				handle.unref?.();
				return handle;
			},
			clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
		};
		const sweepMs = options.sweepMs ?? Math.max(1_000, Math.floor(this.idleMs / 3));
		this.sweep = this.timers.setInterval(() => this.sweepIdle(), sweepMs);
	}

	/** Conversation keys with a live session, oldest first. */
	keys(): string[] {
		return [...this.entries.keys()];
	}

	size(): number {
		return this.entries.size;
	}

	/** Whether a question is in flight or queued for the conversation this request maps to. */
	isBusy(request: { repo: RepoIdentity; ref?: string; model: Model<any>; thinkingLevel: ScoutThinking }): boolean {
		const entry = this.entries.get(conversationKey(request));
		return Boolean(entry && (entry.busy || entry.queue.length > 0));
	}

	/**
	 * Ask one question of the request's conversation, waiting for any earlier question to settle
	 * first. Resolves with the report; the entry's idle clock restarts when the question settles.
	 */
	async run(request: ScoutRequest, signal?: AbortSignal): Promise<ScoutResult> {
		if (this.closed) throw new Error("scout registry is closed");
		if (signal?.aborted) throw new Error("the scout question was aborted before it started");
		const key = conversationKey(request);
		const { entry } = await this.entryFor(key, request);
		if (entry.evicted) throw new Error(`scout session for ${key} was evicted before this question ran`);
		const answer = await new Promise<{ report: string; fresh: boolean }>((resolve, reject) => {
			entry.queue.push({ question: request.question, signal, resolve, reject });
			this.pump(entry);
		});
		return { report: answer.report, dir: entry.dir, sessionFile: entry.sessionFile, fresh: answer.fresh, warnings: entry.warnings };
	}

	/** Evict one session now. The running question and everything queued fail. */
	async evict(key: string): Promise<boolean> {
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.entries.delete(key);
		entry.evicted = true;
		const error = new Error(`scout session for ${key} was evicted before this question ran`);
		for (const waiter of entry.queue.splice(0)) waiter.reject(error);
		if (entry.inFlight) {
			const running = entry.inFlight;
			entry.inFlight = undefined;
			running.reject(new Error(`scout session for ${key} was evicted while this question ran`));
		}
		entry.conversation.abort?.();
		entry.conversation.dispose();
		this.release(entry.dir, key);
		this.log.info(`scout: evicted ${key}`);
		return true;
	}

	/** Dispose every session and stop the sweeper. Idempotent. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.timers.clearInterval(this.sweep);
		await Promise.allSettled([...this.opening.values()]);
		for (const key of [...this.entries.keys()]) await this.evict(key);
	}

	private async entryFor(key: string, request: ScoutRequest): Promise<{ entry: Entry }> {
		const existing = this.entries.get(key);
		if (existing) {
			// Re-insert so Map iteration order tracks recency.
			this.entries.delete(key);
			this.entries.set(key, existing);
			return { entry: existing };
		}
		const pending = this.opening.get(key);
		if (pending) return { entry: await pending };
		const opening = this.open(key, request);
		this.opening.set(key, opening);
		try {
			return { entry: await opening };
		} finally {
			this.opening.delete(key);
		}
	}

	private async open(key: string, request: ScoutRequest): Promise<Entry> {
		const { dir, display, warning } = await this.options.checkout({ repo: request.repo, ref: request.ref });
		const warnings: string[] = warning ? [warning] : [];
		// A tree another live conversation reads must not move under it. Its opener refreshed it.
		if (!this.owners.has(dir)) {
			try {
				await this.options.refresh(dir, request.ref);
			} catch (error) {
				warnings.push("refresh failed: " + (error instanceof Error ? error.message : String(error)));
			}
		}
		const sessionFile = this.sessionFiles.get(key) ?? this.options.sessionFileFor(key);
		const conversation = await this.options.adapter.open(display, dir, sessionFile, {
			model: request.model,
			thinkingLevel: request.thinkingLevel,
		});
		if (this.closed) {
			conversation.dispose();
			throw new Error("scout registry is closed");
		}
		// pi names the file it creates; remember what it wrote so the reopen continues that file.
		const written = conversation.sessionFile();
		if (written) this.sessionFiles.set(key, written);
		const entry: Entry = {
			key,
			dir,
			sessionFile: written ?? sessionFile,
			conversation,
			queue: [],
			inFlight: undefined,
			busy: false,
			evicted: false,
			lastUsedAt: this.now(),
			warnings,
		};
		this.entries.set(key, entry);
		const owners = this.owners.get(dir) ?? new Set<string>();
		owners.add(key);
		this.owners.set(dir, owners);
		this.log.info(`scout: opened session for ${key} at ${dir}`);
		return entry;
	}

	private release(dir: string, key: string): void {
		const owners = this.owners.get(dir);
		if (!owners) return;
		owners.delete(key);
		if (owners.size === 0) this.owners.delete(dir);
	}

	private pump(entry: Entry): void {
		if (entry.busy || entry.evicted) return;
		const next = entry.queue.shift();
		if (!next) return;
		entry.busy = true;
		entry.inFlight = next;
		void this.runOne(entry, next);
	}

	private async runOne(entry: Entry, waiter: Waiter): Promise<void> {
		// Read freshness before the turn: answering is what makes a conversation no longer new.
		const fresh = entry.conversation.fresh();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					entry.conversation.abort?.();
					reject(new Error(`scout turn for ${entry.key} timed out after ${this.turnMs} ms`));
				}, this.turnMs);
				timer.unref?.();
			});
			const report = await Promise.race([entry.conversation.ask(waiter.question, waiter.signal), deadline]);
			waiter.resolve({ report, fresh });
		} catch (error) {
			if (entry.evicted) waiter.reject(new Error(`scout session for ${entry.key} was evicted while this question ran`));
			else waiter.reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			if (timer) clearTimeout(timer);
			entry.busy = false;
			entry.inFlight = undefined;
			entry.lastUsedAt = this.now();
			if (!entry.evicted) this.pump(entry);
		}
	}

	/** Evict every session quiet for longer than the idle window. */
	private sweepIdle(): void {
		const cutoff = this.now() - this.idleMs;
		for (const [key, entry] of [...this.entries]) {
			if (entry.busy || entry.queue.length > 0) continue;
			if (entry.lastUsedAt > cutoff) continue;
			void this.evict(key);
		}
	}
}
