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

export interface Clock {
	now(): number;
	advance(ms: number): void;
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

export const seeded = (store: AccountStore): readonly AccountRecord[] =>
	store.accounts.map((entry) => ({
		account: entry,
		health: { kind: "live" },
		standing: { search: { kind: "open", lastUsedAt: null }, fetch: { kind: "open", lastUsedAt: null } },
	}));
