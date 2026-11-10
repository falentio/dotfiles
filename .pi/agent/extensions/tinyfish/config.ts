/** Constants and the environment readers. Nothing here branches. */

export interface PoolConfig {
	/** An all-cooling call that would wait longer than this throws instead. */
	readonly maxWaitMs: number;
}

export interface CallConfig {
	/** Transport failures tolerated inside one tool call, before it gives up. */
	readonly maxTransient: number;
	readonly backoffMs: (turn: number) => number;
}

export const POOL_CONFIG: PoolConfig = { maxWaitMs: 300_000 };

export const CALL_CONFIG: CallConfig = {
	maxTransient: 3,
	backoffMs: (turn) => 250 * 2 ** (turn - 1),
};

export const SEARCH_BASE_URL = "https://api.search.tinyfish.ai";
export const FETCH_BASE_URL = "https://api.fetch.tinyfish.ai";

export const searchBaseUrl = (): string => process.env.TINYFISH_SEARCH_BASE_URL ?? SEARCH_BASE_URL;
export const fetchBaseUrl = (): string => process.env.TINYFISH_FETCH_BASE_URL ?? FETCH_BASE_URL;

/** A 402/403 idles the account this long: a wallet top-up is not observable from here. */
export const SPENT_COOLDOWN_MS = 900_000;

/** The window a 429 falls back to when its body and its Retry-After header say nothing. */
export const DEFAULT_WINDOW_MS = 60_000;
