/**
 * The session registry: one conversation per repo and ref, serialized, evicted when idle.
 *
 * Pure bookkeeping. Everything decidable without a model, a network, or the pi SDK lives here so it
 * can be tested: queue order, the idle clock, the turn deadline, which conversation a request maps
 * to, and which session file to reopen after an eviction. The agent itself is behind
 * `ScoutAdapter`; `agent-session.ts` is the one implementation.
 *
 * The conversation key is the repo and the ref, nothing else. A model is how the conversation is
 * read, not which conversation it is, so a request with a different model or thinking level is
 * rebound to the new model on the same transcript. Across processes the repo lock enforces the same
 * rule: one live reader of one repo at one ref, with the persisted session index handing the next
 * process the transcript the last one wrote.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import { SCOUT_CONFIG } from "./config.ts";
import type { RepoIdentity } from "./repo-id.ts";
import type { ReleaseLock } from "./state-lock.ts";

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

/**
 * The conversation a request maps to: the repo and the ref.
 *
 * The repo part is escaped so that a repo key containing `@` cannot alias a different repo at a
 * ref, and a ref may then contain anything git accepts.
 */
export const conversationKey = (request: { repo: RepoIdentity; ref?: string }): string => {
	const repo = request.repo.key.replaceAll("%", "%25").replaceAll("@", "%40");
	return request.ref ? repo + "@" + request.ref : repo;
};

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

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface ScoutRegistryOptions {
	/**
	 * Take the cross-process lock for this repo and ref, held until the conversation is evicted.
	 * The second process to ask waits here instead of opening a second session on the same tree.
	 */
	acquire: (request: { repo: RepoIdentity; ref?: string }, signal?: AbortSignal) => Promise<ReleaseLock>;
	/** Clone the tree when it is missing, and verify an existing tree belongs to this repo. */
	checkout: (request: { repo: RepoIdentity; ref?: string }) => Promise<{ dir: string; display: string; warning?: string }>;
	/** Move an existing tree to the requested ref. Throws on failure. */
	refresh: (dir: string, ref?: string) => Promise<void>;
	adapter: ScoutAdapter;
	/** The transcript a previous turn, in this process or another, recorded for this key. */
	sessionFileFor: (key: string) => Promise<string | undefined>;
	/** Where a brand-new conversation's file should live. pi may name a different one. */
	newSessionFile: (key: string) => string;
	/** Persist the file pi actually wrote, so the next process reopens it. */
	rememberSession: (key: string, file: string) => Promise<void>;
	/** Idle window in ms. Defaults to `SCOUT_CONFIG.idleMs`. */
	idleMs?: number;
	/** Idle sweep interval in ms. Defaults to a third of `idleMs`, at least 1s. */
	sweepMs?: number;
	/** One turn's ceiling in ms. Defaults to `SCOUT_CONFIG.turnMs`. */
	turnMs?: number;
	log?: Logger;
	now?: () => number;
	/** Timer seam, so tests drive the clock without waiting. */
	timers?: {
		setInterval(fn: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
}

type Entry = {
	key: string;
	dir: string;
	/** The repo as the report names it. */
	display: string;
	/** How this conversation is currently bound. */
	model: Model<any>;
	thinkingLevel: ScoutThinking;
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
	/** Releases the cross-process lock. */
	release: ReleaseLock;
};

type Waiter = {
	question: string;
	model: Model<any>;
	thinkingLevel: ScoutThinking;
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
	/** Aborted on shutdown, so an open waiting on another process's lock does not hold the exit. */
	private readonly closing = new AbortController();
	private closed = false;

	private readonly options: ScoutRegistryOptions;

	constructor(options: ScoutRegistryOptions) {
		this.options = options;
		this.idleMs = options.idleMs ?? SCOUT_CONFIG.idleMs;
		this.turnMs = options.turnMs ?? SCOUT_CONFIG.turnMs;
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
		// An hour window must not mean an hour of slop: sweep at most every five minutes.
		const sweepMs = options.sweepMs ?? Math.max(1_000, Math.min(300_000, Math.floor(this.idleMs / 3)));
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
	isBusy(request: { repo: RepoIdentity; ref?: string }): boolean {
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
		const { entry } = await this.entryFor(key, request, signal);
		if (entry.evicted) throw new Error(`scout session for ${key} was evicted before this question ran`);
		const answer = await new Promise<{ report: string; fresh: boolean }>((resolve, reject) => {
			entry.queue.push({
				question: request.question,
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				signal,
				resolve,
				reject,
			});
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
		try {
			await entry.release();
		} catch (error) {
			this.log.warn(`scout: releasing ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.log.info(`scout: evicted ${key}`);
		return true;
	}

	/** Dispose every session and stop the sweeper. Idempotent. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.timers.clearInterval(this.sweep);
		this.closing.abort();
		await Promise.allSettled([...this.opening.values()]);
		for (const key of [...this.entries.keys()]) await this.evict(key);
	}

	private async entryFor(key: string, request: ScoutRequest, signal?: AbortSignal): Promise<{ entry: Entry }> {
		const existing = this.entries.get(key);
		if (existing) {
			// Re-insert so Map iteration order tracks recency.
			this.entries.delete(key);
			this.entries.set(key, existing);
			return { entry: existing };
		}
		const pending = this.opening.get(key);
		if (pending) return { entry: await pending };
		const opening = this.open(key, request, signal);
		this.opening.set(key, opening);
		try {
			return { entry: await opening };
		} finally {
			this.opening.delete(key);
		}
	}

	private async open(key: string, request: ScoutRequest, signal?: AbortSignal): Promise<Entry> {
		const release = await this.options.acquire({ repo: request.repo, ref: request.ref }, this.untilClose(signal));
		let handedOver = false;
		try {
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
			const sessionFile =
				this.sessionFiles.get(key) ?? (await this.options.sessionFileFor(key)) ?? this.options.newSessionFile(key);
			const conversation = await this.options.adapter.open(display, dir, sessionFile, {
				model: request.model,
				thinkingLevel: request.thinkingLevel,
			});
			if (this.closed) {
				conversation.dispose();
				throw new Error("scout registry is closed");
			}
			// pi names the file it creates; remember what it wrote so a reopen continues that file.
			const written = conversation.sessionFile();
			if (written) await this.remember(key, written);
			const entry: Entry = {
				key,
				dir,
				display,
				model: request.model,
				thinkingLevel: request.thinkingLevel,
				sessionFile: written ?? sessionFile,
				conversation,
				queue: [],
				inFlight: undefined,
				busy: false,
				evicted: false,
				lastUsedAt: this.now(),
				warnings,
				release,
			};
			this.entries.set(key, entry);
			const owners = this.owners.get(dir) ?? new Set<string>();
			owners.add(key);
			this.owners.set(dir, owners);
			handedOver = true;
			this.log.info(`scout: opened session for ${key} at ${dir}`);
			return entry;
		} finally {
			// Opening failed or the registry closed: hand the tree back to the next process.
			if (!handedOver) await release();
		}
	}

	/** Abort the caller asks for, or this registry closing, whichever comes first. */
	private untilClose(signal?: AbortSignal): AbortSignal {
		if (!signal) return this.closing.signal;
		const controller = new AbortController();
		const abort = () => controller.abort();
		if (signal.aborted || this.closing.signal.aborted) controller.abort();
		else {
			signal.addEventListener("abort", abort, { once: true });
			this.closing.signal.addEventListener("abort", abort, { once: true });
		}
		return controller.signal;
	}

	private async remember(key: string, file: string): Promise<void> {
		this.sessionFiles.set(key, file);
		try {
			await this.options.rememberSession(key, file);
		} catch (error) {
			this.log.warn(`scout: recording ${key} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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
		try {
			await this.rebind(entry, waiter);
		} catch (error) {
			waiter.reject(error instanceof Error ? error : new Error(String(error)));
			this.settle(entry);
			return;
		}
		// Read freshness after a rebind: a rebind replays the transcript, so it is no longer new.
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
			this.settle(entry);
		}
	}

	private settle(entry: Entry): void {
		entry.busy = false;
		entry.inFlight = undefined;
		entry.lastUsedAt = this.now();
		if (!entry.evicted) this.pump(entry);
	}

	/**
	 * Move the conversation onto the model the next question asks with. One transcript per repo and
	 * ref is the promise; the model is read at the moment of asking, so a second caller with another
	 * model continues the same file instead of opening a second session.
	 */
	private async rebind(entry: Entry, waiter: Waiter): Promise<void> {
		// Compare the model's identity, not the object: every request resolves its own Model value.
		const sameModel =
			waiter.model === entry.model ||
			(waiter.model.provider === entry.model.provider && waiter.model.id === entry.model.id);
		if (sameModel && waiter.thinkingLevel === entry.thinkingLevel) return;
		const file = entry.conversation.sessionFile() ?? entry.sessionFile;
		this.log.info(
			`scout: rebinding ${entry.key} to ${waiter.model.provider}/${waiter.model.id} (${waiter.thinkingLevel})`,
		);
		const conversation = await this.options.adapter.open(entry.display, entry.dir, file, {
			model: waiter.model,
			thinkingLevel: waiter.thinkingLevel,
		});
		// Open before disposing the old one: a failed open must leave the entry usable.
		try {
			entry.conversation.dispose();
		} catch {
			// The old conversation is being replaced either way.
		}
		entry.conversation = conversation;
		entry.model = waiter.model;
		entry.thinkingLevel = waiter.thinkingLevel;
		const written = conversation.sessionFile();
		if (written) {
			entry.sessionFile = written;
			await this.remember(entry.key, written);
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
