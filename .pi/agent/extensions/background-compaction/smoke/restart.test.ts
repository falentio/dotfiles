import { describe, expect, it } from "bun:test";
import { runTwice } from "./run.ts";

const GATE = 156_074;

describe("survives a process restart", () => {
	it("reopens a compacted session and prompts without a second summary", async () => {
		const result = await runTwice({ extension: "background-compaction" });
		expect(result.first.turns).toBeGreaterThan(0);
		expect(result.first.summaryRequests).toBe(1);
		expect(result.first.compactions.length).toBe(1);
		expect(result.first.compactions[0]!.fromHook).toBe(true);

		expect(result.second.turns).toBe(2);
		expect(result.second.summaryRequests).toBe(0);
		expect(result.second.compactions.length).toBe(1);
		expect(result.second.compactions[0]).toEqual(result.first.compactions[0]);
		expect(result.second.tokens).not.toBeNull();
		expect(result.second.tokens!).toBeLessThan(GATE);
	}, 90_000);

	it("reopens a compacted session without the extension the same way", async () => {
		const result = await runTwice({ extension: "none" });
		expect(result.first.compactions.length).toBe(1);
		expect(result.first.compactions[0]!.fromHook).toBe(false);
		expect(result.second.turns).toBe(2);
		expect(result.second.summaryRequests).toBe(0);
		expect(result.second.compactions.length).toBe(1);
	}, 90_000);
});
