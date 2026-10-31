/**
 * Harness-compaction settings. This file is the only extension settings source: no environment
 * variable or other file is read. The gate reads pi's own compaction reserve through
 * `reserveTokensFor` so it never sits above the trigger pi checks first. The defaults copy the
 * DeepSeek Harness (DSH) compaction pruner.
 */
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import { codePointLength, type PruneBudget } from "./prune.ts";

export interface HarnessCompactionConfig {
	/** Off: every hook returns nothing and pi behaves as shipped. */
	readonly enabled: boolean;
	/** Fraction of the model's context window at which the prune starts. DSH thresholdRatio. */
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

/** The part of pi's settings the gate needs: its compaction headroom. */
export interface ReserveSettings {
	readonly reserveTokens?: number;
	readonly modelOverrides?: Readonly<Record<string, { readonly reserveTokens?: number } | undefined>>;
}

/**
 * pi's reserve for the active model, in pi's own precedence: the model override, then
 * `compaction.reserveTokens`, then its built-in default.
 */
export function reserveTokensFor(
	compaction: ReserveSettings | undefined,
	model?: { readonly provider: string; readonly id: string },
): number {
	const override = model ? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]?.reserveTokens : undefined;
	return override ?? compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

export function pruneBudget(config: HarnessCompactionConfig): PruneBudget {
	return {
		thresholdChars: config.thresholdChars,
		headChars: config.headChars,
		tailChars: config.tailChars,
		marker: config.marker,
	};
}

/**
 * Where the prune starts: DSH's `min(thresholdRatio x window, window - reserve)`. The headroom
 * half is pi's own compaction trigger, and a gate above it never opens, because pi checks its
 * trigger first and reports no token count until an assistant response follows the compaction.
 */
export function pruneGate(config: HarnessCompactionConfig, contextWindow: number, reserveTokens: number): number {
	return Math.max(0, Math.min(config.pruneAtRatio * contextWindow, contextWindow - reserveTokens));
}

export function shouldPrune(
	config: HarnessCompactionConfig,
	usage: { readonly tokens: number | null; readonly contextWindow: number },
	reserveTokens: number,
): boolean {
	return config.enabled && usage.tokens !== null && usage.tokens >= pruneGate(config, usage.contextWindow, reserveTokens);
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
