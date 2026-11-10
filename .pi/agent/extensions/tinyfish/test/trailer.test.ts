import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");
const README = readFileSync(join(DIR, "README.md"), "utf8");

/** Every finding the review raised, from the table that carries them. */
const rules = [...README.matchAll(/^\| ([HMLN]\d+) \|/gm)].map((match) => match[1] ?? "");

/**
 * The rules the branch records in `Rule:` trailers. Commit shas are deliberately not asserted: a
 * rebase rewrites them, and the trailer is the part a reader greps for.
 */
const shipped = new Set(
	Bun.spawnSync(["git", "log", "--format=%b", "origin/main..HEAD"], { cwd: DIR })
		.stdout.toString()
		.split("\n")
		.filter((line) => line.startsWith("Rule: "))
		.map((line) => line.slice("Rule: ".length).trim()),
);

describe("the review table", () => {
	it("lists every finding, once each", () => {
		expect(new Set(rules).size).toBe(rules.length);
		expect(rules.length).toBeGreaterThan(0);
	});

	it("has a commit on this branch carrying each finding's trailer", () => {
		const missing = rules.filter((rule) => !shipped.has(rule));
		expect(missing).toEqual([]);
	});
});
