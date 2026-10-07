#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const skills = [["tinyfish-search-fetch", ["tools.tinyfish.search", "tools.tinyfish.fetch_content"]]];
const failures = [];

for (const [directory, tools] of skills) {
  const skillPath = join(root, directory, "SKILL.md");
  const skill = readFileSync(skillPath, "utf8");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
  const name = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1].trim();
  const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim();

  if (!frontmatter) failures.push(`${skillPath}: missing frontmatter`);
  if (name !== directory) failures.push(`${skillPath}: name must be ${directory}`);
  if (!description) failures.push(`${skillPath}: missing description`);
  for (const tool of tools) {
    if (!skill.includes(`\`${tool}\``)) failures.push(`${skillPath}: missing ${tool}`);
  }
  if (!skill.includes("## Examples")) failures.push(`${skillPath}: missing examples section`);
  if (skill.includes("—")) failures.push(`${skillPath}: contains an em dash`);

  for (const match of skill.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (target && !target.startsWith("http") && !existsSync(join(root, directory, target))) {
      failures.push(`${skillPath}: missing linked file ${target}`);
    }
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
