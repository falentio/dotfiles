import type { Account, AccountId, AccountStore } from "./accounts.ts";
import { POOL_CONFIG, SPENT_COOLDOWN_MS, type PoolConfig } from "./config.ts";
import { ENDPOINTS, spacingOf, type EndpointId } from "./endpoints.ts";
import { exhausted, toolError, type Depletion, type TinyfishToolError } from "./errors.ts";

/** What one 429 said, kept so the eventual error can name the limit. */
export interface Limit {
	readonly limit: number;
	readonly unit: string;
	readonly windowSeconds: number;
}

/**
 * Per account, per endpoint. A cooling standing always carries its release, an open one never does, so
 * "cooling with no release" cannot be written down.
 */
export type Standing =
	| { readonly kind: "open"; readonly lastUsedAt: number | null }
	| { readonly kind: "cooling"; readonly until: number; readonly limit: Limit | null };

/** Per account, both endpoints. Checked before any standing. */
export type Health =
	| { readonly kind: "live" }
	| { readonly kind: "spent"; readonly until: number; readonly walletUrl: string | null }
	| { readonly kind: "dead" };

export interface AccountRecord {
	readonly account: Account;
	readonly health: Health;
	readonly standing: Readonly<Record<EndpointId, Standing>>;
}

/** The whole pool state. Replaced, never mutated. */
export interface Registry {
	readonly records: readonly AccountRecord[];
	/** The index the last acquire took, or -1 before the first, so a fresh pool starts at account one. */
	readonly cursor: number;
}

export type Wait = (ms: number, signal: AbortSignal | undefined) => Promise<void>;

export interface Lease {
	readonly account: Account;
	/** Grade the attempt. The second call is a no-op, so a handler that releases and then throws is safe. */
	release(outcome: Outcome): void;
}

export interface Pool {
	/** `deadline` bounds the total wait; the caller owns it so one call has one budget, not one per turn. */
	acquire(endpoint: EndpointId, signal?: AbortSignal, deadline?: number): Promise<Lease>;
	/** The pool's clock, so a caller can compute a deadline in the same units the pacing uses. */
	now(): number;
	snapshot(): Registry;
	/** Re-seed from a freshly read store, keeping health, standing, and order by account id. */
	reload(store: AccountStore): void;
}

export interface PoolSeed {
	readonly store: AccountStore;
	readonly now?: () => number;
	readonly wait?: Wait;
	readonly config?: PoolConfig;
}

export type Ok = { readonly kind: "ok" };
export type Invalid = { readonly kind: "invalid"; readonly error: TinyfishToolError };

/**
 * The grade of one attempt. A closed set, so both the release table and the retry match fail to compile
 * when an arm is added. `invalid` is an arm because the release path must see it, even though it is a no-op.
 */
export type Outcome =
	| Ok
	| Invalid
	| { readonly kind: "rate-limited"; readonly windowMs: number; readonly limit: Limit | null }
	| { readonly kind: "dead-key" }
	| { readonly kind: "spent"; readonly walletUrl: string | null }
	| { readonly kind: "transient" };

/** What rotation matches on: every arm but `ok`. */
export type NonOk = Exclude<Outcome, Ok>;

const open = (lastUsedAt: number | null): Standing => ({ kind: "open", lastUsedAt });

const allOpen = (at: number | null): Record<EndpointId, Standing> => ({ search: open(at), fetch: open(at) });

export const seedRecords = (store: AccountStore): readonly AccountRecord[] =>
	store.accounts.map((account) => ({ account, health: { kind: "live" }, standing: allOpen(null) }));

export const cursorOf = (registry: Registry | undefined): AccountId | null => {
	if (registry === undefined) return null;
	return registry.records.at(registry.cursor)?.account.id ?? null;
};

/** Shared by acquire and the test fake: setTimeout, rejected by the signal, cleared on both paths. */
export const defaultWait: Wait = (ms, signal) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason as Error);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, Math.max(0, ms));
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason as Error);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** The pacing stamp plus the cursor move, written in the same synchronous step as the selection. */
export const stamped = (registry: Registry, index: number, endpoint: EndpointId, at: number): Registry => ({
	cursor: index,
	records: registry.records.map((record, i) =>
		i === index ? { ...record, standing: { ...record.standing, [endpoint]: open(at) } } : record,
	),
});

/**
 * The pacing floor: when this key's spacing alone lets it go again. A key never used here is free from
 * the start, not one spacing after the epoch. A cooling arm answers with its release, because the
 * cooldown already outruns any spacing.
 */
const floorOf = (record: AccountRecord, endpoint: EndpointId): number => {
	const standing = record.standing[endpoint];
	if (standing.kind === "cooling") return standing.until;
	const lastUsedAt = standing.lastUsedAt;
	return lastUsedAt === null ? Number.NEGATIVE_INFINITY : lastUsedAt + spacingOf(ENDPOINTS[endpoint], record.account);
};

/**
 * The release table. `transient` moves the stamp one spacing on instead of opening the account, so the
 * turn that retries right away lands on the next key rather than back on the one that just failed.
 */
export const graded = (
	registry: Registry,
	accountId: AccountId,
	endpoint: EndpointId,
	outcome: Outcome,
	now: number,
): Registry => {
	const index = registry.records.findIndex((record) => record.account.id === accountId);
	const record = registry.records[index];
	if (record === undefined) return registry;
	const standing = record.standing[endpoint];
	let next: AccountRecord = record;
	switch (outcome.kind) {
		case "ok":
			next = { ...record, standing: { ...record.standing, [endpoint]: open(standing.kind === "open" ? standing.lastUsedAt : null) } };
			break;
		case "rate-limited":
			next = {
				...record,
				standing: { ...record.standing, [endpoint]: { kind: "cooling", until: now + outcome.windowMs, limit: outcome.limit } },
			};
			break;
		case "dead-key":
			next = { ...record, health: { kind: "dead" }, standing: { ...record.standing, [endpoint]: open(null) } };
			break;
		case "spent":
			next = { ...record, health: { kind: "spent", until: now + SPENT_COOLDOWN_MS, walletUrl: outcome.walletUrl } };
			break;
		case "transient": {
			if (standing.kind === "cooling") break;
			const base = Math.max(standing.kind === "open" ? (standing.lastUsedAt ?? now) : now, now);
			next = {
				...record,
				standing: { ...record.standing, [endpoint]: open(base + spacingOf(ENDPOINTS[endpoint], record.account)) },
			};
			break;
		}
		case "invalid":
			break;
	}
	return { ...registry, records: registry.records.map((r, i) => (i === index ? next : r)) };
};

/** When this record could serve this endpoint again. One function, so nothing above branches on health. */
export const readyAt = (record: AccountRecord, endpoint: EndpointId): number => {
	switch (record.health.kind) {
		case "dead":
			return Number.POSITIVE_INFINITY;
		case "spent":
			return record.health.until;
		case "live":
			return floorOf(record, endpoint);
	}
};

export const usable = (record: AccountRecord, endpoint: EndpointId, now: number): boolean =>
	readyAt(record, endpoint) <= now;

export type Selection =
	| { readonly kind: "take"; readonly index: number }
	| { readonly kind: "wait"; readonly readyAt: number; readonly unless: Depletion }
	| { readonly kind: "exhausted"; readonly reason: Depletion };

/** How many records sit out of credits, and the soonest of them returns. */
const spentOf = (registry: Registry): { spentCount: number; spentAt: number | null } => {
	let spentCount = 0;
	let spentAt: number | null = null;
	for (const record of registry.records) {
		if (record.health.kind !== "spent") continue;
		spentCount += 1;
		if (spentAt === null || record.health.until < spentAt) spentAt = record.health.until;
	}
	return { spentCount, spentAt };
};

const depletionOf = (registry: Registry, record: AccountRecord, endpoint: EndpointId): Depletion => {
	if (record.health.kind === "spent") return { kind: "all-spent", walletUrl: record.health.walletUrl };
	const standing = record.standing[endpoint];
	return {
		kind: "all-cooling",
		endpoint,
		releaseAt: readyAt(record, endpoint),
		limit: standing.kind === "cooling" ? standing.limit : null,
		tried: [],
		...spentOf(registry),
	};
};

/**
 * The first due record after the cursor, wrapping. Two passes: live records, then spent ones, so a wallet
 * 402 never outranks a key that is merely paced. With nothing due it answers the earliest arrival and
 * what running past it would mean.
 */
export const select = (registry: Registry, endpoint: EndpointId, now: number): Selection => {
	const size = registry.records.length;
	if (size === 0) return { kind: "exhausted", reason: { kind: "no-accounts" } };
	const order = (predicate: (record: AccountRecord) => boolean): Selection => {
		for (let step = 1; step <= size; step += 1) {
			const index = (registry.cursor + step) % size;
			const record = registry.records[index];
			if (record !== undefined && predicate(record)) return { kind: "take", index };
		}
		return { kind: "exhausted", reason: { kind: "all-dead" } };
	};
	const live = order((record) => record.health.kind === "live" && usable(record, endpoint, now));
	if (live.kind === "take") return live;
	const spent = order((record) => record.health.kind === "spent" && usable(record, endpoint, now));
	if (spent.kind === "take") return spent;
	let upcoming: { record: AccountRecord; releaseAt: number } | undefined;
	for (const record of registry.records) {
		const releaseAt = readyAt(record, endpoint);
		if (!Number.isFinite(releaseAt)) continue;
		if (upcoming === undefined || releaseAt < upcoming.releaseAt) upcoming = { record, releaseAt };
	}
	if (upcoming === undefined) return { kind: "exhausted", reason: { kind: "all-dead" } };
	return { kind: "wait", readyAt: upcoming.releaseAt, unless: depletionOf(registry, upcoming.record, endpoint) };
};

export const createPool = (seed: PoolSeed): Pool => {
	const now = seed.now ?? Date.now;
	const wait = seed.wait ?? defaultWait;
	const config = seed.config ?? POOL_CONFIG;
	let registry: Registry = { records: seedRecords(seed.store), cursor: -1 };

	const leaseOver = (index: number, endpoint: EndpointId): Lease => {
		const record = registry.records[index];
		if (record === undefined) throw toolError(exhausted({ kind: "no-accounts" }));
		let released = false;
		return {
			account: record.account,
			release(outcome) {
				if (released) return;
				released = true;
				registry = graded(registry, record.account.id, endpoint, outcome, now());
			},
		};
	};

	return {
		async acquire(endpoint, signal, deadline = now() + config.maxWaitMs) {
			for (;;) {
				const selection = select(registry, endpoint, now());
				switch (selection.kind) {
					case "take": {
						registry = stamped(registry, selection.index, endpoint, now());
						return leaseOver(selection.index, endpoint);
					}
					case "wait": {
						if (selection.readyAt > deadline) throw toolError(exhausted(selection.unless));
						await wait(Math.min(selection.readyAt, deadline) - now(), signal);
						break;
					}
					case "exhausted":
						throw toolError(exhausted(selection.reason));
				}
			}
		},
		now,
		snapshot: () => registry,
		reload(store) {
			const kept = new Map(registry.records.map((record) => [record.account.id, record]));
			const records = store.accounts.map((account): AccountRecord => {
				const record = kept.get(account.id);
				return record === undefined ? { account, health: { kind: "live" }, standing: allOpen(null) } : { ...record, account };
			});
			const from = cursorOf(registry);
			registry = { cursor: from === null ? -1 : records.findIndex((record) => record.account.id === from), records };
		},
	};
};
