import type { Account, AccountStore } from "../accounts.ts";
import type { AccountRecord } from "../pool.ts";

export const account = (id: string, key = `key-${id}`): Account => ({
	id,
	label: id,
	key: key as Account["key"],
	weight: 1,
});

export const storeOf = (...ids: string[]): AccountStore => ({
	accounts: ids.map((id) => account(id)),
	cursor: null,
});

/** A clock and a wait the test drives, so no case spends real millis. */
export interface Clock {
	now(): number;
	advance(ms: number): void;
	/** Every wait either pool asked for, in order. */
	waits: number[];
	wait: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export function clock(start = 1_000_000): Clock {
	let at = start;
	const waits: number[] = [];
	return {
		now: () => at,
		advance(ms) {
			at += ms;
		},
		waits,
		async wait(ms) {
			waits.push(ms);
			at += Math.max(0, ms);
		},
	};
}

export const bearer = (limit = 30, windowSeconds = 60): unknown => ({
	error: { code: "RATE_LIMIT_EXCEEDED", message: "slow down", details: { limit, unit: "minute", window_seconds: windowSeconds } },
});

export const spentBody = (walletUrl?: string): unknown => ({
	error: {
		code: "INSUFFICIENT_CREDITS",
		message: "no credits",
		...(walletUrl === undefined ? {} : { details: { wallet_url: walletUrl } }),
	},
});

export const seeded = (store: AccountStore): readonly AccountRecord[] =>
	store.accounts.map((account) => ({
		account,
		health: { kind: "live" },
		standing: { search: { kind: "open", lastUsedAt: null }, fetch: { kind: "open", lastUsedAt: null } },
	}));
