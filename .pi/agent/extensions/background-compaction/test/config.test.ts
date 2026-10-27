import { describe, expect, it } from "bun:test";
import {
	PRECOMPUTE_CONFIG,
	ceiling,
	gate,
	limits,
	tailLimit,
	validateConfig,
	type PrecomputeConfig,
} from "../config.ts";

const valid: PrecomputeConfig = { ...PRECOMPUTE_CONFIG };

describe("PRECOMPUTE_CONFIG", () => {
	it("matches the frozen defaults", () => {
		expect(PRECOMPUTE_CONFIG).toEqual({
			enabled: true,
			compactWhenReady: true,
			compactAtRatio: 0.85,
			minCeilingTokens: 64_000,
			reserveTokens: 16_384,
			keepRecentTokens: 20_000,
			tailShare: 0.25,
			tailMin: 30_000,
			maxFailures: 2,
		});
	});

	it("validates once at module load", () => {
		expect(() => validateConfig(PRECOMPUTE_CONFIG)).not.toThrow();
	});
});

describe("validateConfig", () => {
	const rejected: Array<[string, PrecomputeConfig]> = [
		["compactAtRatio 0", { ...valid, compactAtRatio: 0 }],
		["compactAtRatio above 1", { ...valid, compactAtRatio: 1.01 }],
		["compactAtRatio NaN", { ...valid, compactAtRatio: Number.NaN }],
		["compactAtRatio non-number", { ...valid, compactAtRatio: "0.85" as never }],
		["minCeilingTokens 0", { ...valid, minCeilingTokens: 0 }],
		["minCeilingTokens fractional", { ...valid, minCeilingTokens: 1.5 }],
		["reserveTokens negative", { ...valid, reserveTokens: -1 }],
		["reserveTokens fractional", { ...valid, reserveTokens: 0.5 }],
		["keepRecentTokens 0", { ...valid, keepRecentTokens: 0 }],
		["keepRecentTokens fractional", { ...valid, keepRecentTokens: 1.5 }],
		["tailShare 0", { ...valid, tailShare: 0 }],
		["tailShare above 0.5", { ...valid, tailShare: 0.51 }],
		["tailShare NaN", { ...valid, tailShare: Number.NaN }],
		["tailMin negative", { ...valid, tailMin: -1 }],
		["tailMin fractional", { ...valid, tailMin: 0.5 }],
		["maxFailures negative", { ...valid, maxFailures: -1 }],
		["maxFailures fractional", { ...valid, maxFailures: 0.5 }],
		["enabled non-boolean", { ...valid, enabled: "yes" as never }],
		["compactWhenReady non-boolean", { ...valid, compactWhenReady: 1 as never }],
	];

	for (const [name, config] of rejected) {
		it(`rejects ${name}`, () => {
			expect(() => validateConfig(config)).toThrow();
		});
	}

	it("accepts every inclusive boundary", () => {
		expect(() =>
			validateConfig({
				...valid,
				compactAtRatio: 1,
				tailShare: 0.5,
				reserveTokens: 0,
				tailMin: 0,
				maxFailures: 0,
			}),
		).not.toThrow();
	});
});

describe("derived limits", () => {
	it("ceiling subtracts the reserve from the window", () => {
		expect(ceiling(200_000)).toBe(183_616);
		expect(ceiling(16_384)).toBe(0);
	});

	it("gate floors the ratio of the ceiling", () => {
		expect(gate(200_000)).toBe(156_073);
		expect(gate(100_000)).toBe(71_073);
	});

	it("tail limit uses the larger of twice the keep window and tailMin", () => {
		expect(tailLimit(200_000)).toBe(40_000);
		expect(tailLimit(1_000_000)).toBe(40_000);
	});

	it("tail limit falls back to the share of the ceiling on a small window", () => {
		expect(tailLimit(100_000)).toBe(20_904);
	});

	it("tail limit can be set by tailMin alone", () => {
		const config: PrecomputeConfig = { ...valid, keepRecentTokens: 1_000 };
		expect(tailLimit(200_000, config)).toBe(30_000);
	});

	it("limits bind every field the state machine consumes", () => {
		const value = limits();
		expect(value).toMatchObject({
			enabled: PRECOMPUTE_CONFIG.enabled,
			compactWhenReady: PRECOMPUTE_CONFIG.compactWhenReady,
			reserveTokens: PRECOMPUTE_CONFIG.reserveTokens,
			keepRecentTokens: PRECOMPUTE_CONFIG.keepRecentTokens,
			compactAtRatio: PRECOMPUTE_CONFIG.compactAtRatio,
			minCeilingTokens: PRECOMPUTE_CONFIG.minCeilingTokens,
			maxFailures: PRECOMPUTE_CONFIG.maxFailures,
		});
		expect(value.tail(200_000)).toBe(tailLimit(200_000));
	});
});
