/**
 * The session registry: one live scout per repo, serialized, evicted when idle.
 *
 * Pure bookkeeping. Everything that can be decided without a model, a network, or the pi SDK lives
 * here so it can be tested: queue order, the idle clock, which session a repo maps to, and which
 * session file to reopen after an eviction. The agent itself is behind `ScoutAdapter`;
 * `agent-session.ts` is the one implementation, and `scout-session.ts` supplies the real loader.
 */

/** What the registry needs from whoever owns the conversations. */
export interface ScoutAdapter {
	/** Open a conversation about `repo`, reading `dir`, replaying `sessionFile` when it exists. */
	open(repo: string, dir: string, sessionFile: string | undefined): Promise<ScoutConversation>;
}

export interface ScoutConversation {
	/** Run one question to completion. Rejects on failure. */
	ask(question: string, signal: AbortSignal | undefined): Promise<string>;
	/** The session file the conversation is recorded to, if any. */
	sessionFile(): string | undefined;
	/** True while this conversation is new and has not answered yet. */
	fresh(): boolean;
	dispose(): void;
}

/**
 * Where a session file should live, given the repo key. This is only a starting point: pi names the
 * file it creates and the conversation reports back what it actually wrote, so the registry remembers
 * that path instead. Getting this wrong would start a new file after every eviction, throwing away
 * the cache the eviction is supposed to preserve.
 */
export type SessionFileFor = (key: string) => string;

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface ScoutRegistryOptions {
	/** Path to the scratch checkout for a repo, with its display name. */
	prepare: (key: string) => Promise<{ dir: string; display: string }>;
	adapter: ScoutAdapter;
	sessionFileFor: SessionFileFor;
	/** Idle window in ms. A session quiet for this long is evicted. */
	idleMs?: number;
	/** Idle sweep interval in ms. Defaults to a third of `idleMs`, at least 1s. */
	sweepMs?: number;
	log?: Logger;
	now?: () => number;
	/** Timer seam, so tests drive the clock without waiting. */
	timers?: {
		setInterval(fn: () => void, ms: number): unknown;
		clearInterval(handle: unknown): void;
	};
	/** Called when a session is evicted, for a file that should follow it. */
	onEvict?: (key: string) => void;
};

const DEFAULT_IDLE_MS = 600_000;

type Entry = {
	key: string;
	dir: string;
	/** The conversation file pi actually wrote, remembered for the reopen after an eviction. */
	sessionFile: string | undefined;
	conversation: ScoutConversation;
	/** Questions waiting for the current one, FIFO. */
	queue: Waiter[];
	busy: boolean;
	/** Set when an idle sweep evicted the entry, so `run` stops using it. */
	evicted: boolean;
	lastUsedAt: number;
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
};

export class ScoutRegistry {
	private readonly entries = new Map<string, Entry>();
	/** The file each key's conversation was recorded to, surviving eviction. */
	private readonly sessionFiles = new Map<string, string>();
	/** Keys with work in flight: one ticket per key, so a first run opens one session, not two. */
	private readonly opening = new Map<string, Promise<Entry>>();
	private readonly idleMs: number;
	private readonly log: Logger;
	private readonly now: () => number;
	private readonly timers: NonNullable<ScoutRegistryOptions["timers"]>;
	private readonly sweep: unknown;
	private readonly onEvict: (key: string) => void;
	private closed = false;

	private readonly options: ScoutRegistryOptions;

	constructor(options: ScoutRegistryOptions) {
		this.options = options;
		this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? { info: () => {}, warn: () => {}, error: () => {} };
		this.onEvict = options.onEvict ?? (() => {});
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

	/** Keys with a live session, oldest first. */
	keys(): string[] {
		return [...this.entries.keys()];
	}

	size(): number {
		return this.entries.size;
	}

	/** Whether a question is in flight or queued for `key`. */
	isBusy(key: string): boolean {
		const entry = this.entries.get(key);
		return Boolean(entry && (entry.busy || entry.queue.length > 0));
	}

	/**
	 * Ask one question of the repo's session, waiting for any earlier question to settle first.
	 * Resolves with the report; the entry's idle clock restarts when the question settles.
	 */
	async run(key: string, question: string, signal?: AbortSignal): Promise<ScoutResult> {
		if (this.closed) throw new Error("scout registry is closed");
		const { entry } = await this.entryFor(key);
		const answer = await new Promise<{ report: string; fresh: boolean }>((resolve, reject) => {
			entry.queue.push({ question, signal, resolve, reject });
			this.pump(entry);
		});
		const { report, fresh } = answer;
		return { report, dir: entry.dir, sessionFile: entry.sessionFile, fresh };
	}

	/** Evict one session now. In-flight work is aborted. */
	async evict(key: string): Promise<boolean> {
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.entries.delete(key);
		entry.evicted = true;
		for (const waiter of entry.queue.splice(0)) {
			waiter.reject(new Error(`scout session for ${key} was evicted before this question ran`));
		}
		entry.conversation.dispose();
		this.onEvict(key);
		this.log.info(`scout: evicted ${key}`);
		// Let an in-flight turn notice; the conversation is already disposed.
		return true;
	}

	/** Dispose every session and stop the sweeper. Idempotent. */
	async shutdown(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.timers.clearInterval(this.sweep);
		for (const key of [...this.entries.keys()]) await this.evict(key);
	}

	private async entryFor(key: string): Promise<{ entry: Entry }> {
		const existing = this.entries.get(key);
		if (existing && !existing.evicted) {
			// Re-insert so Map iteration order tracks recency.
			this.entries.delete(key);
			this.entries.set(key, existing);
			return { entry: existing };
		}

		const pending = this.opening.get(key);
		if (pending) {
			return { entry: await pending };
		}

		const opening = this.open(key);
		this.opening.set(key, opening);
		try {
			return { entry: await opening };
		} finally {
			this.opening.delete(key);
		}
	}

	private async open(key: string): Promise<Entry> {
		const { dir, display } = await this.options.prepare(key);
		const sessionFile = this.sessionFiles.get(key) ?? this.options.sessionFileFor(key);
		const conversation = await this.options.adapter.open(display, dir, sessionFile);
		// pi names the file it creates; remember what it wrote so the reopen continues that file.
		const written = conversation.sessionFile();
		if (written) this.sessionFiles.set(key, written);
		const entry: Entry = {
			key,
			dir,
			sessionFile: written ?? sessionFile,
			conversation,
			queue: [],
			busy: false,
			evicted: false,
			lastUsedAt: this.now(),
		};
		this.entries.set(key, entry);
		this.log.info(`scout: opened session for ${key} at ${dir}`);
		return entry;
	}

	private pump(entry: Entry): void {
		if (entry.busy || entry.evicted) return;
		const next = entry.queue.shift();
		if (!next) return;
		entry.busy = true;
		this.runOne(entry, next);
	}

	private async runOne(entry: Entry, waiter: Waiter): Promise<void> {
		try {
			// Read freshness before the turn: answering is what makes a conversation no longer new.
			const fresh = entry.conversation.fresh();
			const report = await entry.conversation.ask(waiter.question, waiter.signal);
			waiter.resolve({ report, fresh });
		} catch (error) {
			if (entry.evicted) waiter.reject(new Error(`scout session for ${entry.key} was evicted while this question ran`));
			else waiter.reject(error instanceof Error ? error : new Error(String(error)));
		} finally {
			entry.busy = false;
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
