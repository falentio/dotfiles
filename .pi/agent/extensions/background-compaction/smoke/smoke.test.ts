import { describe, expect, it } from "bun:test";
import { run, type Scenario } from "./run.ts";

const TIMEOUT = 60_000;

function summaryCompactions(result: Awaited<ReturnType<typeof run>>) {
	return result.compactions.filter((entry) => entry.fromHook);
}

describe("smoke: a real session through the extension", () => {
	it("compacts from the precomputed summary before the next prompt", async () => {
		const result = await run({ extension: "background-compaction" });
		expect(result.summaryRequests).toBe(1);
		expect(result.compactions.length).toBe(1);
		expect(result.compactions[0]!.fromHook).toBe(true);
		expect(result.events[0]).toBe("start:manual");
	}, TIMEOUT);

	it("baseline: without the extension the threshold compacts and the summary follows", async () => {
		const result = await run({ extension: "none" });
		expect(result.compactions.length).toBe(1);
		expect(result.compactions[0]!.fromHook).toBe(false);
		expect(result.summaryRequests).toBeGreaterThanOrEqual(1);
	}, TIMEOUT);

	it("writes a summary and holds it when compactWhenReady is false", async () => {
		const result = await run({ extension: "background-compaction", compactWhenReady: "false" });
		expect(result.summaryRequests).toBeGreaterThanOrEqual(1);
		expect(result.compactions.every((entry) => entry.fromHook)).toBe(false);
	}, TIMEOUT);

	it("drops the summary when the kept tail grew past the limit", async () => {
		const scenario: Scenario = { extension: "background-compaction", compactWhenReady: "false", tailMin: 1_000, keepRecentTokens: 1_000 };
		const result = await run(scenario);
		expect(result.summaryRequests).toBeGreaterThanOrEqual(1);
		expect(summaryCompactions(result).length).toBe(0);
	}, TIMEOUT);
});
