import type { Limits } from "./state.ts";

export interface IdleCompactConfig {
	readonly enabled: boolean;
	readonly idleMs: number;
	readonly minTokens: number;
}

export const IDLE_COMPACT_CONFIG = {
	enabled: true,
	idleMs: 60 * 60 * 1000,
	minTokens: 40_000,
} as const;

export function validateConfig(config: IdleCompactConfig): void {
	requireBoolean("enabled", config.enabled);
	requireInteger("idleMs", config.idleMs, 0);
	requireInteger("minTokens", config.minTokens, 0);
}

function requireBoolean(name: string, value: unknown): void {
	if (typeof value !== "boolean") {
		throw new TypeError(`${name} must be a boolean`);
	}
}

function requireInteger(name: string, value: unknown, min: number): void {
	if (!Number.isInteger(value) || (value as number) < min) {
		throw new RangeError(`${name} must be an integer of at least ${min}`);
	}
}

validateConfig(IDLE_COMPACT_CONFIG);

export function limits(config: IdleCompactConfig = IDLE_COMPACT_CONFIG): Limits {
	return {
		enabled: config.enabled,
		idleMs: config.idleMs,
		minTokens: config.minTokens,
	};
}
