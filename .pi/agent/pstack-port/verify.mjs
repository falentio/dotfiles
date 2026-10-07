#!/usr/bin/env node
// End-to-end verification of the pstack -> pi port.
// Boots pi headless and asserts every surface the port promises.
// Run: node ~/.pi/agent/pstack-port/verify.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const AGENT = "/home/kevin/.pi/agent";
// 49 source skills + 2 generated persona skills + todo-discipline.
const EXPECTED_SKILLS = 52;
const EXPECTED_POTETO_TOOLS = 25;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function pi(args) {
  return execFileSync("pi", args, { cwd: "/tmp", encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// 1. Skills on disk
const skillDirs = execFileSync("find", [join(AGENT, "skills"), "-name", "SKILL.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
check("skills on disk", skillDirs.length === EXPECTED_SKILLS, `${skillDirs.length}/${EXPECTED_SKILLS}`);

// 2. Skills advertised in the system prompt
const disco = pi(["--print", "--no-session", "--mode", "json", "hi"]);
const advertised = new Set();
for (const m of disco.matchAll(/<location>(.*?\/\.pi\/agent\/skills\/([a-z0-9-]+)\/SKILL\.md)<\/location>/g)) {
  advertised.add(m[2]);
}
check("skills advertised by pi", advertised.size === EXPECTED_SKILLS, `${advertised.size}/${EXPECTED_SKILLS}`);

// 3. No opencode idioms left in skill prose. The pattern list is read from the
// codemod source so the two can never drift apart.
const codemodSrc = readFileSync(join(AGENT, "pstack-port/adapt-skills.mjs"), "utf8");
const idiomBlock = codemodSrc.match(/const IDIOM_PATTERNS = \[([\s\S]*?)\];/);
const IDIOM_PATTERNS = [...(idiomBlock?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
  JSON.parse(`"${m[1]}"`),
);
let idioms = 0;
for (const f of execFileSync("find", [join(AGENT, "skills"), "-name", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean)) {
  const text = readFileSync(f, "utf8");
  for (const pat of IDIOM_PATTERNS) {
    if (text.includes(pat)) idioms++;
  }
}
check(
  "no opencode idioms in skills",
  IDIOM_PATTERNS.length > 0 && idioms === 0,
  `${idioms} occurrences across ${IDIOM_PATTERNS.length} patterns`,
);

// 3b. delegate_task is named exactly as the live T3 tool declares it. Skills
// reach it from a codemode script, so the name must be the underscore form
// inside a `tools.` access: `tools.mcp__t3_code__delegate_task`. Hyphens are
// illegal in a JS identifier, and with `codemode.mode: "only"` no top-level
// tool of that name exists. A bare `delegate_task` is not a tool at all.
let bareDelegate = 0;
for (const f of execFileSync("find", [join(AGENT, "skills"), "-name", "*.md"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean)) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/delegate_task/g)) {
    const before = text.slice(Math.max(0, m.index - 16), m.index);
    if (!before.endsWith("mcp__t3-code__") && !before.endsWith("mcp__t3_code__")) bareDelegate++;
  }
}
check("delegate_task always namespaced in skills", bareDelegate === 0, `${bareDelegate} bare references`);

// 3c. The installed tree must be exactly what the codemod generates. Running it
// in --check mode against the installed skills catches prose drift, persona drift,
// and a stale persona skill in one structural check rather than brittle strings.
// TO-TEST's open question was answered NOT VERIFIED: T3's `role` loads no persona,
// so each persona ships as a skill the delegate prose requires the child to invoke.
let codemodClean = false;
try {
  execFileSync("node", [join(AGENT, "pstack-port/adapt-skills.mjs"), "--check"], { encoding: "utf8" });
  codemodClean = true;
} catch {
  codemodClean = false;
}
check("installed skills match the codemod output", codemodClean, "codemod --check exit 0");

for (const skill of ["comment-sicko", "poteto-agent"]) {
  check(`persona skill ${skill} exists`, existsSync(join(AGENT, `skills/${skill}/SKILL.md`)));
}

const noComments = readFileSync(join(AGENT, "skills/no-comments/SKILL.md"), "utf8");
check(
  "no-comments requires the comment-sicko persona skill",
  noComments.includes("comment-sicko` persona skill"),
);

// 3d. The poteto-mode subagent note must require implementation delegates to
// invoke the persona skill, since `role` does not load agents/poteto-agent.md.
const potetoMode = readFileSync(join(AGENT, "skills/poteto-mode/SKILL.md"), "utf8");
check(
  "poteto-mode requires the poteto-agent persona skill",
  potetoMode.includes("poteto-agent` persona skill") && potetoMode.includes("never a persona loader"),
);

// 4. Tools callable from codemode
const toolOut = pi([
  "--print",
  "--no-session",
  "Call codemode with a script that returns JSON.stringify(ALL_TOOLS.map(t=>t.name).filter(n=>n.startsWith('poteto_')).sort()). Output only the script result.",
]);
const potetoTools = JSON.parse(toolOut.match(/\[[^\]]*\]/)?.[0] ?? "[]");
check("poteto_* tools registered", potetoTools.length === EXPECTED_POTETO_TOOLS, `${potetoTools.length}/${EXPECTED_POTETO_TOOLS}`);

// 5. Prompt template
check("/poteto-mode prompt template", existsSync(join(AGENT, "prompts/poteto-mode.md")));

// 6. Agent files (personas for the delegate_task roles)
for (const agent of ["general", "poteto-agent", "comment-sicko"]) {
  check(`agent file ${agent}.md`, existsSync(join(AGENT, `agents/${agent}.md`)));
}

// 7. Extension files
for (const f of ["index.ts", "compaction.ts"]) {
  check(`extension ${f}`, existsSync(join(AGENT, `extensions/pstack/${f}`)));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
