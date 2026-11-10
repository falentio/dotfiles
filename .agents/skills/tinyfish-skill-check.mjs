#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const repo = join(root, "..", "..");
const failures = [];

/** The registered identifiers, read from the extension source so this check cannot drift from it. */
const names = readFileSync(join(repo, ".pi", "agent", "extensions", "tinyfish", "names.ts"), "utf8");
const tools = [...names.matchAll(/"(tinyfish_[a-z_]+)"/g)].map((match) => `tools.${match[1]}`);
if (tools.length === 0) failures.push(`${names}: no tool names found`);

const skillPath = join(root, "tinyfish-search-fetch", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
const name = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1].trim();
const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim();

if (!frontmatter) failures.push(`${skillPath}: missing frontmatter`);
if (name !== "tinyfish-search-fetch") failures.push(`${skillPath}: name must be tinyfish-search-fetch`);
if (!description) failures.push(`${skillPath}: missing description`);
for (const tool of tools) {
  if (!skill.includes(`\`${tool}\``)) failures.push(`${skillPath}: missing ${tool}`);
}
if (!skill.includes("## Examples")) failures.push(`${skillPath}: missing examples section`);
if (skill.includes("—")) failures.push(`${skillPath}: contains an em dash`);

/**
 * `tools.<identifier>` works for a flat name, and that is the form the skill documents. A dotted one
 * is a string key, so it only resolves as `tools["<name>"]`; a dotted call the skill shows as a call
 * has to be that form.
 */
const registered = new Set(tools.map((tool) => tool.slice("tools.".length)));
for (const match of skill.matchAll(/tools\.([a-z_]+)\b(?!\.)/g)) {
  if (!registered.has(match[1])) failures.push(`${skillPath}: tools.${match[1]} is not a registered tool`);
}
for (const block of [...skill.matchAll(/^```[a-z]*\n([\s\S]*?)^```/gm)].map((match) => match[1])) {
  for (const match of block.matchAll(/tools\.(tinyfish\.[a-z_]+)/g)) {
    failures.push(`${skillPath}: tools.${match[1]} in a code block needs tools["${match[1]}"]`);
  }
}

for (const match of skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  const target = match[1].split("#", 1)[0];
  if (target && !target.startsWith("http") && !existsSync(join(root, "tinyfish-search-fetch", target))) {
    failures.push(`${skillPath}: missing linked file ${target}`);
  }
}

for (const obsoleteDirectory of ["tinyfish-search", "tinyfish-fetch"]) {
  if (existsSync(join(root, obsoleteDirectory))) {
    failures.push(`${obsoleteDirectory}: obsolete skill directory still exists`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("TinyFish skill structure is valid.");
