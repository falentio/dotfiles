export interface PrecomputeConfig {
	readonly enabled: boolean;
	readonly compactWhenReady: boolean;
	readonly compactAtRatio: number;
	readonly minCeilingTokens: number;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
	readonly tailShare: number;
	readonly tailMin: number;
	readonly maxFailures: number;
}

export const PRECOMPUTE_CONFIG = {
	enabled: true,
	compactWhenReady: true,
	compactAtRatio: 0.85,
	minCeilingTokens: 64_000,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
	tailShare: 0.25,
	tailMin: 30_000,
	maxFailures: 2,
} as const;

export interface Limits {
	readonly enabled: boolean;
	readonly compactWhenReady: boolean;
	readonly reserveTokens: number;
	readonly keepRecentTokens: number;
	readonly compactAtRatio: number;
	readonly minCeilingTokens: number;
	readonly maxFailures: number;
	readonly tail: (contextWindow: number) => number;
}

export function validateConfig(config: PrecomputeConfig): void {
	requireBoolean("enabled", config.enabled);
	requireBoolean("compactWhenReady", config.compactWhenReady);
	requireRatio("compactAtRatio", config.compactAtRatio, 1);
	requireInteger("minCeilingTokens", config.minCeilingTokens, 1);
	requireInteger("reserveTokens", config.reserveTokens, 0);
	requireInteger("keepRecentTokens", config.keepRecentTokens, 1);
	requireRatio("tailShare", config.tailShare, 0.5);
	requireInteger("tailMin", config.tailMin, 0);
	requireInteger("maxFailures", config.maxFailures, 0);
}

function requireBoolean(name: string, value: unknown): void {
	if (typeof value !== "boolean") {
		throw new TypeError(`${name} must be a boolean`);
	}
}

function requireRatio(name: string, value: unknown, max: number): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > max) {
		throw new RangeError(`${name} must be a number greater than 0 and at most ${max}`);
	}
}

function requireInteger(name: string, value: unknown, min: number): void {
	if (!Number.isInteger(value) || (value as number) < min) {
		throw new RangeError(`${name} must be an integer of at least ${min}`);
	}
}

validateConfig(PRECOMPUTE_CONFIG);

export function ceiling(
	contextWindow: number,
	config: PrecomputeConfig = PRECOMPUTE_CONFIG,
): number {
	return contextWindow - config.reserveTokens;
}

export function gate(
	contextWindow: number,
	config: PrecomputeConfig = PRECOMPUTE_CONFIG,
): number {
	return Math.floor(config.compactAtRatio * ceiling(contextWindow, config));
}

export function tailLimit(
	contextWindow: number,
	config: PrecomputeConfig = PRECOMPUTE_CONFIG,
): number {
	const ceilingTokens = ceiling(contextWindow, config);
	return Math.min(
		Math.max(2 * config.keepRecentTokens, config.tailMin),
		Math.floor(config.tailShare * ceilingTokens),
	);
}

export function limits(config: PrecomputeConfig = PRECOMPUTE_CONFIG): Limits {
	return {
		enabled: config.enabled,
		compactWhenReady: config.compactWhenReady,
		reserveTokens: config.reserveTokens,
		keepRecentTokens: config.keepRecentTokens,
		compactAtRatio: config.compactAtRatio,
		minCeilingTokens: config.minCeilingTokens,
		maxFailures: config.maxFailures,
		tail: (contextWindow) => tailLimit(contextWindow, config),
	};
}
