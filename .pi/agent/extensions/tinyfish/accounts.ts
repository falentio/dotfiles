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
	/** Pacing multiplier: 1 by default, more for an account with a bigger allowance. */
	readonly weight: number;
}

/** The file shape, parsed. Junk stops here. */
export interface AccountStore {
	readonly accounts: readonly Account[];
	readonly cursor: AccountId | null;
}

export const EMPTY_STORE: AccountStore = { accounts: [], cursor: null };

/** Fully qualified, not "~/": the CLI is a mini-app and a path shim can break a leading tilde. */
export const CLI_CONFIG_PATH = join(homedir(), ".tinyfish", "config.json");

export const STORE_PATH = process.env.TINYFISH_ACCOUNTS_FILE ?? join(homedir(), ".tinyfish", "accounts.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const asKey = (value: string): ApiKey => value as ApiKey;

const asWeight = (value: unknown): number =>
	typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 1;

/**
 * Total over junk: one hand-edited record drops out instead of failing the whole read, because a
 * single bad entry must not cost the operator every other key.
 */
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

/** A missing or unreadable file yields an empty store: the pool owns the "no key" message. */
export const readStore = async (path: string = STORE_PATH): Promise<AccountStore> => {
	try {
		return parseStore(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return EMPTY_STORE;
	}
};

const writeStore = async (store: AccountStore, path: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
};

/**
 * Capture the key the CLI left behind. Both sources (this and a pasted key) append, never replace, and
 * both are keyed by the key itself so a repeated login is a no-op.
 */
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
	await writeStore(next, STORE_PATH);
	return next;
};

/** Same append path as capture, for a key pasted into `tinyfish auth set`. */
export const addAccount = async (key: string, store: AccountStore): Promise<AccountStore> => {
	if (store.accounts.some((account) => account.key === key)) return store;
	const id = nextId(store);
	const next: AccountStore = {
		accounts: [...store.accounts, { id, label: id, key: asKey(key), weight: 1 }],
		cursor: store.cursor,
	};
	await writeStore(next, STORE_PATH);
	return next;
};

/** The lowest free `a<N>`, so a deleted middle entry does not hand its id to a newcomer. */
const nextId = (store: AccountStore): AccountId => {
	const taken = new Set(store.accounts.map((account) => account.id));
	let n = store.accounts.length + 1;
	while (taken.has(`a${n}`)) n += 1;
	return `a${n}`;
};

export const saveCursor = async (cursor: AccountId | null): Promise<void> => {
	const store = await readStore();
	await writeStore({ ...store, cursor }, STORE_PATH);
};
