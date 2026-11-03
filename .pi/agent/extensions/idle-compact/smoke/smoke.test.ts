import { describe, expect, it } from "bun:test";
import { SUMMARY_MARKER } from "./probe.ts";
import { run } from "./run.ts";

const TIMEOUT = 60_000;

const carries = (result: Awaited<ReturnType<typeof run>>, text: string) =>
	result.last?.texts.some((entry) => entry.includes(text)) ?? false;

describe("smoke: a real session through the extension", () => {
	it("compacts the idle context and re-sends the swallowed prompt", async () => {
		const result = await run("idle-compact");
		expect(result.compactions).toBe(1);
		expect(result.events).toContain("start:manual");
		expect(result.summaryRequests).toBe(1);
		expect(carries(result, SUMMARY_MARKER)).toBe(true);
		expect(carries(result, "bloat turn 2")).toBe(true);
	}, TIMEOUT);

	it("baseline: without the extension the prompt meets the whole transcript", async () => {
		const result = await run("none");
		expect(result.compactions).toBe(0);
		expect(result.summaryRequests).toBe(0);
		expect(result.markedRequests).toBe(0);
		expect(carries(result, "bloat turn 2")).toBe(true);
	}, TIMEOUT);

	it("shrinks the cached prefix below the un-compacted baseline", async () => {
		const compacted = await run("idle-compact");
		const baseline = await run("none");
		if (compacted.last === undefined || baseline.last === undefined) throw new Error("no request was recorded");
		expect(compacted.last.roles.length).toBeLessThan(baseline.last.roles.length);
	}, TIMEOUT);
});
