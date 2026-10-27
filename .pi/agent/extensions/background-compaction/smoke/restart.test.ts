import { describe, expect, it } from "bun:test";
import { runTwice } from "./run.ts";

describe("survives a process restart", () => {
	it("writes one summary in the first process and none after reopening", async () => {
		const result = await runTwice({ extension: "background-compaction" });
		expect(result.first.turns).toBeGreaterThan(0);
		expect(result.first.summaryRequests).toBe(1);
		expect(result.first.compactions.length).toBe(1);
		expect(result.first.compactions[0]!.fromHook).toBe(true);

		expect(result.second.summaryRequests).toBe(0);
		expect(result.second.compactions.length).toBe(1);
		expect(result.second.compactions[0]).toEqual(result.first.compactions[0]);
	}, 90_000);

	it("reopens a compacted session without writing another summary", async () => {
		const result = await runTwice({ extension: "none" });
		expect(result.first.turns).toBeGreaterThan(0);
		expect(result.first.compactions.length).toBe(1);
		expect(result.second.summaryRequests).toBe(0);
		expect(result.second.compactions.length).toBe(1);
	}, 90_000);
});
