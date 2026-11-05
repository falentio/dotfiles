import { describe, expect, it } from "bun:test";
import { TODO_OPERATIONS } from "../operations.ts";
import { TODO_TOOL_DESCRIPTION } from "../prompts.ts";

function rowsFor(op: string): string[] {
	return TODO_TOOL_DESCRIPTION.split("\n").filter((line) =>
		line.startsWith(`|\`${op}\`|`),
	);
}

describe("TODO_TOOL_DESCRIPTION", () => {
	it("renders a table row for every operation", () => {
		for (const op of TODO_OPERATIONS) {
			expect(rowsFor(op).length).toBeGreaterThan(0);
		}
	});

	it("tells the model an omitted target hits every task for done and drop", () => {
		expect(rowsFor("done")[0]).toContain("omit both");
		expect(rowsFor("drop")[0]).toContain("omit both");
	});
});
