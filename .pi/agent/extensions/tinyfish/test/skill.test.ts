import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MCP_NAMES, TOOL_NAMES } from "../names.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");
const SKILL = join(REPO, ".agents", "skills", "tinyfish-search-fetch", "SKILL.md");

const flat = new Set<string>(Object.values(TOOL_NAMES));
const dotted = new Set<string>(Object.values(MCP_NAMES));

const brackets = (skill: string): string[] =>
	[...skill.matchAll(/tools\["([a-z_.]+)"\]/g)].map((match) => match[1] ?? "");

/** `tools.<name>`, which reaches a flat identifier only: a dotted name needs the bracket form. */
const bare = (skill: string): string[] =>
	[...skill.matchAll(/tools\.([a-z_]+(?:\.[a-z_]+)?)/g)].map((match) => match[1] ?? "");

describe("the skill", () => {
	const skill = readFileSync(SKILL, "utf8");

	it("calls only registered tools", () => {
		const unknown = bare(skill).filter((name) => !flat.has(name) && !dotted.has(name));
		expect(unknown).toEqual([]);
	});

	it("never writes a dotted call, which tools has no member for", () => {
		const called = new Set(brackets(skill));
		for (const name of called) expect(dotted.has(name)).toBe(true);
		// A dotted name may be named in prose, but the call itself is documented in the bracket form.
		for (const name of bare(skill).filter((candidate) => candidate.includes("."))) {
			expect(called.has(name)).toBe(true);
		}
	});
});
