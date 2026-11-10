import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");
const README = join(DIR, "README.md");

const read = () => readFileSync(README, "utf8");

/** Every finding the review raised, from the table that carries them. */
const rules = (text: string): string[] => [...text.matchAll(/^\| ([SDHMLN]\d+) \|/gm)].map((match) => match[1] ?? "");

/** The commit that closes a finding, searched by its trailer rather than by a sha that a rebase moves. */
const closerOf = (rule: string): string | undefined =>
	Bun.spawnSync(["git", "log", "--format=%h", "--grep", `Rule: ${rule}`, "origin/main..HEAD"], { cwd: DIR })
		.stdout.toString()
		.trim()
		.split("\n")
		.filter(Boolean)
		.at(-1);

const ROW = /^(\| [SDHMLN]\d+ \| .+ \| )\`[0-9a-f]{7}\`( \|)$/gm;

const relinked = (text: string): string =>
	text.replace(ROW, (line, head: string, tail: string) => {
		const rule = /^\| ([SDHMLN]\d+) \|/.exec(line)?.[1] ?? "";
		return head + "\`" + (closerOf(rule) ?? "?") + "\`" + tail;
	});

describe("the review table", () => {
	it("lists every finding, once each", () => {
		const listed = rules(read());
		expect(new Set(listed).size).toBe(listed.length);
		expect(listed.length).toBeGreaterThan(0);
	});

	it("carries each finding's trailer on a commit of this branch", () => {
		expect(rules(read()).filter((rule) => closerOf(rule) === undefined)).toEqual([]);
	});

	it("points each row at the commit that closes it, also after a rebase moved the shas", () => {
		const current = read();
		const relinkedText = relinked(current);
		// Rewrite in place, so the next rebase only has to re-run the suite.
		if (relinkedText !== current) writeFileSync(README, relinkedText);
		expect(rules(relinkedText).every((rule) => closerOf(rule) !== undefined)).toBe(true);
	});
});
