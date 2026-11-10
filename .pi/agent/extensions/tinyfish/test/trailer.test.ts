import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");
const README = readFileSync(join(DIR, "README.md"), "utf8");

/** The review table rows: rule id, then the commit that closes it. */
const rows = [...README.matchAll(/^\| ([HMLN]\d+) \| .+ \| `([0-9a-f]{7})` \|$/gm)].map((match) => ({
	rule: match[1] ?? "",
	commit: match[2] ?? "",
}));

const trailerOf = (commit: string): string =>
	Bun.spawnSync(["git", "log", "-1", "--format=%b", commit], { cwd: DIR }).stdout.toString();

describe("the review table", () => {
	it("lists every finding, once each", () => {
		const rules = rows.map((row) => row.rule);
		expect(new Set(rules).size).toBe(rules.length);
		expect(rules).toHaveLength(21);
	});

	it("names a commit this branch holds, carrying that finding's trailer", () => {
		for (const row of rows) {
			const body = trailerOf(row.commit);
			expect(body.length, `${row.rule}: ${row.commit} is not a commit here`).toBeGreaterThan(0);
			expect(body).toContain(`Rule: ${row.rule}`);
		}
	});
});
