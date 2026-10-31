/**
 * Harness-compaction settings. This file is the only settings source: no environment variable or
 * other file is read. The defaults copy the DeepSeek Harness (DSH) compaction pruner.
 */
import { codePointLength, type PruneBudget } from "./prune.ts";

export interface HarnessCompactionConfig {
	/** Off: both hooks return nothing and pi behaves as shipped. */
	readonly enabled: boolean;
	/** Fraction of the model's context window at which the projection is pruned. DSH thresholdRatio. */
	readonly pruneAtRatio: number;
	/** A tool result with more text code points than this is pruned. DSH thresholdChars. */
	readonly thresholdChars: number;
	/** Leading code points kept. DSH headChars. */
	readonly headChars: number;
	/** Trailing code points kept. DSH tailChars. */
	readonly tailChars: number;
	/** Text inserted where the middle was. DSH marker. */
	readonly marker: string;
	/**
	 * The summary a compaction entry carries. pi always renders a summary wrapper, so an empty
	 * string would leave a message with no body.
	 */
	readonly droppedHistoryNote: string;
}

export const CONFIG: HarnessCompactionConfig = {
	enabled: true,
	pruneAtRatio: 0.8,
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024,
	marker: "\n\n[... tool result middle pruned ...]\n\n",
	droppedHistoryNote:
		"No summary was written: the earlier history was dropped and the retained messages continue verbatim.",
};

export function pruneBudget(config: HarnessCompactionConfig): PruneBudget {
	return {
		thresholdChars: config.thresholdChars,
		headChars: config.headChars,
		tailChars: config.tailChars,
		marker: config.marker,
	};
}

export function pruneGate(config: HarnessCompactionConfig, contextWindow: number): number {
	return config.pruneAtRatio * contextWindow;
}

export function shouldPrune(
	config: HarnessCompactionConfig,
	usage: { readonly tokens: number | null; readonly contextWindow: number },
): boolean {
	return config.enabled && usage.tokens !== null && usage.tokens >= pruneGate(config, usage.contextWindow);
}

/**
 * Throw on a config a prune cannot converge from. Clamping would hide the misconfiguration and
 * leave a pass that keeps every result as large as its input.
 */
export function validateConfig(config: HarnessCompactionConfig): void {
	requireBoolean("enabled", config.enabled);
	requireRatio("pruneAtRatio", config.pruneAtRatio);
	requireInteger("thresholdChars", config.thresholdChars, 1);
	requireInteger("headChars", config.headChars, 0);
	requireInteger("tailChars", config.tailChars, 0);
	requireText("marker", config.marker);
	requireText("droppedHistoryNote", config.droppedHistoryNote);

	const retained = config.headChars + codePointLength(config.marker) + config.tailChars;
	if (retained >= config.thresholdChars) {
		throw new RangeError(
			`headChars + marker + tailChars = ${retained} must be below thresholdChars = ${config.thresholdChars}`,
		);
	}
}

function requireBoolean(name: string, value: unknown): void {
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
}

function requireRatio(name: string, value: unknown): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
		throw new RangeError(`${name} must be a number greater than 0 and at most 1`);
	}
}

function requireInteger(name: string, value: unknown, min: number): void {
	if (!Number.isInteger(value) || (value as number) < min) {
		throw new RangeError(`${name} must be an integer of at least ${min}`);
	}
}

function requireText(name: string, value: unknown): void {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${name} must be a non-empty string`);
	}
}
