import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

declare const KEY: unique symbol;
export type ApiKey = string & { readonly [KEY]: true };

export type AccountId = string;

export interface Account {
	readonly id: AccountId;
	readonly label: string;
	readonly key: ApiKey;
	readonly weight: number;
}

export interface AccountStore {
	readonly accounts: readonly Account[];
	readonly cursor: AccountId | null;
}

export const EMPTY_STORE: AccountStore = { accounts: [], cursor: null };

export const CLI_CONFIG_PATH = join(homedir(), ".tinyfish", "config.json");

/** Read per call, not at import: a test points it at a temp dir, and a shell can point it anywhere. */
export const storePath = (): string =>
	process.env.TINYFISH_ACCOUNTS_FILE ?? join(homedir(), ".tinyfish", "accounts.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const asKey = (value: string): ApiKey => value as ApiKey;

const asWeight = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;

/** One bad hand-edited record must not cost the operator every other key. */
export const parseStore = (raw: unknown): AccountStore => {
	if (!isRecord(raw)) return EMPTY_STORE;
	const entries = Array.isArray(raw.accounts) ? raw.accounts : [];
	const accounts: Account[] = [];
	for (const [index, entry] of entries.entries()) {
		const source: Record<string, unknown> = isRecord(entry) ? entry : { key: entry };
		const key = text(source.key);
		if (key === null) continue;
		const id = text(source.id) ?? `a${index + 1}`;
		if (accounts.some((account) => account.id === id)) continue;
		accounts.push({ id, label: text(source.label) ?? id, key: asKey(key), weight: asWeight(source.weight) });
	}
	const cursor = text(raw.cursor);
	return { accounts, cursor: cursor !== null && accounts.some((a) => a.id === cursor) ? cursor : null };
};

export interface StoreLoad {
	readonly store: AccountStore;
	readonly brokenAt: string | null;
}

const isCode = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === code;

/** Best effort: a store that cannot be copied still yields the empty store. */
const keepBroken = async (raw: string, path: string): Promise<string | null> => {
	const kept = `${path}.broken`;
	try {
		await writeFile(kept, raw, { mode: 0o600, flag: "wx" });
		return kept;
	} catch (error) {
		return isCode(error, "EEXIST") ? kept : null;
	}
};

/**
 * A file that is there and will not parse is copied aside first and the path reported, so the entry
 * point can say the keys went missing.
 */
export const readStore = async (path: string = storePath()): Promise<StoreLoad> => {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return { store: EMPTY_STORE, brokenAt: null };
	}
	try {
		return { store: parseStore(JSON.parse(raw)), brokenAt: null };
	} catch {
		return { store: EMPTY_STORE, brokenAt: await keepBroken(raw, path) };
	}
};

const writeStore = async (store: AccountStore, path: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
};

/** Keyed by the key itself, so a repeated login is a no-op. */
export const captureFromCli = async (
	store: AccountStore,
	path: string = CLI_CONFIG_PATH,
): Promise<AccountStore> => {
	let config: unknown;
	try {
		config = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return store;
	}
	const key = isRecord(config) ? text(config.api_key) : null;
	if (key === null || store.accounts.some((account) => account.key === key)) return store;
	const label = isRecord(config) ? text(config.account_email ?? config.email) : null;
	const id = nextId(store);
	const next: AccountStore = {
		accounts: [...store.accounts, { id, label: label ?? "cli login", key: asKey(key), weight: 1 }],
		cursor: store.cursor,
	};
	await writeStore(next, storePath());
	return next;
};

export interface AddResult {
	readonly store: AccountStore;
	readonly duplicateOf: AccountId | null;
}

/**
 * A key already in the store is a no-op that names its id, so the CLI can say which entry to revoke.
 */
export const addAccount = async (key: string, store: AccountStore): Promise<AddResult> => {
	const held = store.accounts.find((account) => account.key === key);
	if (held !== undefined) return { store, duplicateOf: held.id };
	const id = nextId(store);
	const next: AccountStore = {
		accounts: [...store.accounts, { id, label: id, key: asKey(key), weight: 1 }],
		cursor: store.cursor,
	};
	await writeStore(next, storePath());
	return { store: next, duplicateOf: null };
};

const nextId = (store: AccountStore): AccountId => {
	const taken = new Set(store.accounts.map((account) => account.id));
	let n = store.accounts.length + 1;
	while (taken.has(`a${n}`)) n += 1;
	return `a${n}`;
};

/**
 * Written from the store that was parsed in, not a fresh read, so a shutdown never comes from a guess.
 * The account list is re-read once and merged, because `tinyfish-auth-set` adds keys from another
 * process and a blind write here would drop one.
 */
export const saveCursor = async (store: AccountStore, cursor: AccountId | null): Promise<void> => {
	const latest = await readStore();
	const known = new Set(store.accounts.map((account) => account.id));
	const merged = latest.store.accounts.filter((account) => !known.has(account.id));
	const accounts = merged.length === 0 ? store.accounts : [...store.accounts, ...merged];
	await writeStore({ accounts, cursor }, storePath());
};
