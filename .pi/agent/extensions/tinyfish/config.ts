export interface PoolConfig {
	readonly maxWaitMs: number;
}

export interface CallConfig {
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

export const SPENT_COOLDOWN_MS = 900_000;

export const DEFAULT_WINDOW_MS = 60_000;
