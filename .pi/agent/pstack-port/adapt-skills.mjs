#!/usr/bin/env node
// Adapts pstack skill prose from opencode idioms to pi idioms.
// Run: node ~/.pi/agent/pstack-port/adapt-skills.mjs [--check]
// --check reports remaining opencode idioms without writing.
// Set PSKILLS_DIR to transform another tree, such as a fresh copy of the source
// skills. Rules are source-to-installed, so run it on a fresh source copy and
// install the result; a second run on already-adapted text is a no-op.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename } from "node:path";

const SKILLS = process.env.PSKILLS_DIR ?? "/home/kevin/.pi/agent/skills";
const AGENTS = process.env.PAGENTS_DIR ?? "/home/kevin/Repositories/opencode-pstack/agents";
const CHECK = process.argv.includes("--check");

// Global exact-string rules, applied to every Markdown file. Order matters.
const GLOBAL = [
  [
    "Invoke referenced skills via the skill tool with `id` set to the skill name. Never open skill files with `read`, `glob`, or `grep`.",
    "Load a referenced skill by reading its `SKILL.md` with the read tool, using the location pi lists for it in the `<available_skills>` block. Never guess a path; resolve it from that block.",
  ],
  ["Load via the skill tool ", "Use "],
  ["pi lists every skill's", "Pi lists every skill's"],
  ["pi stores one JSONL file per session", "Pi stores one JSONL file per session"],
  ["pi stores sessions as JSONL", "Pi stores sessions as JSONL"],
  ["list the available MCPs from the OpenCode environment", "list the available MCPs"],
  ["There is no built-in loop command in opencode.", "There is no built-in loop command in pi."],
  ["Omit `Task.model`", "Omit `delegate_task`'s `target`"],
  ["omit `Task.model`", "omit `delegate_task`'s `target`"],
  ["omitting `Task.model`", "omitting `delegate_task`'s `target`"],
  ["with `Task.model` omitted", "with `delegate_task`'s `target` omitted"],
  ["set their own `subagent_type` for independent review", "name their own `role` for independent review"],
  ["`subagent_type`: `general`", "`role`: `general`"],
  ["subagent_type: \"general\"", "role: \"general\""],
  ["`subagent_type: \"poteto-agent\"`", "`role: \"implementation\"` and a required invocation of the `poteto-agent` persona skill"],
  ["`subagent_type: \"comment-sicko\"`", "`role: \"review\"` and a required invocation of the `comment-sicko` persona skill"],
  ["`Task` calls", "`delegate_task` calls"],
  ["`Task` call", "`delegate_task` call"],
  ["`Task` response body", "`delegate_task` result body"],
  ["`Task` prompts", "`delegate_task` prompts"],
  ["the Task tool", "the `delegate_task` tool"],
  ["via the Task tool", "via `delegate_task`"],
  ["using the Task tool", "using `delegate_task`"],
  ["Spawn `Task` with", "Call `delegate_task` with"],
  ["OpenCode subagents", "pi delegates"],
  ["OpenCode subagent", "pi delegate"],
  ["Match the task to one playbook, invoke the principles it triggers, write the reply unslopped.", "Match the task to one playbook, read the principle skills it triggers, write the reply unslopped."],
  ["A skill-tool call in the history is the proof", "A skill-file read in the history is the proof"],
  ["Spawn a single Task subagent", "Spawn a single `delegate_task` subagent"],
  ["spawn a single Task subagent", "spawn a single `delegate_task` subagent"],
  ["as a background Task with sleep plus poll", "as a background `delegate_task` in `mode: 'async'`, which wakes this thread on completion"],
  ["Repeat the predicate check in a background Task and poll on a heartbeat.", "Repeat the predicate check with a background `delegate_task` in `mode: 'async'` and end your turn; the completion wakes this thread."],
  ["An event to watch (CI, a merge, a ref advancing) gets a watcher subagent that wakes you on the event, with a long time-based heartbeat as fallback.", "An event to watch (CI, a merge, a ref advancing) is watched by this thread itself, which owns the watch: arm T3's `tools.mcp__t3_code__watch_pull_request` on the PR and let its wake arrive here. A subagent cannot watch, so the watch never moves off the parent. Keep a long time-based heartbeat as fallback."],
  ["confirm intent with `question`", "confirm intent with a direct question"],
  ["Do not park reversible work for the human or use `question`.", "Do not park reversible work for the human or raise it as a question."],
  ["Use Glob to find directories and files, Grep to find key symbols, Read to understand the actual implementation.", "Use find to locate directories and files, grep to find key symbols, read to understand the actual implementation."],
  ["Use Read, Grep, and Glob as needed.", "Use read, grep, and find as needed."],
  ["Glob for relevant directories, Grep for key types/interfaces/class names", "find for relevant directories, grep for key types/interfaces/class names"],
  ["The agent does its own exploration (Glob, Grep, Read)", "The agent does its own exploration (find, grep, read)"],
  ["Use the tools available to you (Read, Grep, Glob) to explore.", "Use the tools available to you (read, grep, find, bash) to explore."],
  ["Tool calls (Shell, Grep, MCP, etc.)", "Tool calls (bash, grep, MCP, etc.)"],
  ["Before spawning investigators, list the available MCPs. Use the available-tools map when present.", "Before spawning investigators, list the available MCP servers from pi's tools block in the system prompt (or the `/mcp` command)."],
  ["disable-model-invocation: true\n", ""],
  ["Routing target for `/poteto-mode` and requests", "Routing target for `/skill:poteto-mode` and requests"],
  ["`delegate_task`", "`tools.mcp__t3_code__delegate_task`"],
  // The rename lands the token in noun slots that expect a subagent or a call,
  // not a tool name. Smooth those so the sentence still reads. Order matters:
  // these match the renamed token, so they run after the rule above.
  ["a `tools.mcp__t3_code__delegate_task` with `role:", "a subagent with `tools.mcp__t3_code__delegate_task` and `role:"],
  ["a single `tools.mcp__t3_code__delegate_task` subagent", "a single subagent via `tools.mcp__t3_code__delegate_task`"],
  ["the `tools.mcp__t3_code__delegate_task` tool", "`tools.mcp__t3_code__delegate_task`"],
];

// Per-file exact-string rules for lines with no global equivalent.
const PER_FILE = {
  "poteto-mode/SKILL.md": [
    ["the user types `/poteto-mode`", "the user types `/skill:poteto-mode`"],
    [
      "Scan the index before acting. When a trigger matches, invoke the leaf skill through the skill tool before the work it governs. A skill-tool call in the history is the proof; a citation is not.",
      "Scan the index before acting. When a trigger matches, read the leaf skill's `SKILL.md` with the read tool before the work it governs. A read of the skill file in the history is the proof; a citation is not.",
    ],
    [
      "Reach every skill through the skill tool, with `id` set to its name. `how` is `id: \"how\"`. `principle-laziness-protocol` is `id: \"principle-laziness-protocol\"`. Opening `skills/.../SKILL.md` with `read`, `glob`, or `grep` skips registration and loads a stale copy. This rule covers this file and every playbook.",
      "Reach every skill by reading its `SKILL.md` with the read tool. pi lists every skill's name, description, and absolute location in the `<available_skills>` block of the system prompt. Resolve a skill's directory from that block, then read `<dir>/SKILL.md`. `how` lives in the `how` skill directory and `principle-laziness-protocol` in the `principle-laziness-protocol` directory. Read the whole file; do not grep for fragments. This rule covers this file and every playbook.",
    ],
    ["Invoke each target through the skill tool.", "Read each target skill's `SKILL.md` with the read tool."],
    [
      "Scan every entry before implementation. When a trigger matches, invoke the leaf skill through the skill tool before acting. Done when every matching trigger has a skill-tool call. No match, no invocation.",
      "Scan every entry before implementation. When a trigger matches, read the leaf skill's `SKILL.md` with the read tool before acting. Done when every matching trigger has a skill-file read. No match, no read.",
    ],
    [
      "**Use `subagent_type: \"poteto-agent\"` for any subagent you spawn inside a playbook step** (code-writing delegates, ad-hoc helpers). Routed workflow skills (`how`, `why`, `interrogate`, `reflect`, `swarm`) set their own `subagent_type` for independent review; respect what the skill prescribes.",
      "**Use `role: \"implementation\"` on `delegate_task` for any subagent you spawn inside a playbook step** (code-writing delegates, ad-hoc helpers), and require each to invoke the `poteto-agent` persona skill before any work. Routed workflow skills (`how`, `why`, `interrogate`, `reflect`, `swarm`) name their own `role` for independent review; respect what the skill prescribes. `delegate_task` is provided by T3; it exists only when pi runs inside a T3 thread. T3's `role` is a one-line framing prefix only, never a persona loader, so a persona travels as a skill the child reads.",
    ],
    [
      "**Defaults for every `Task` call.** Run Tasks in parallel by emitting multiple calls in one message, pass file pointers not inlined context, and omit `Task.model` so the subagent inherits the parent chat model. Tier the work by scope and prompt, not by model.",
      "**Defaults for every `delegate_task` call.** Run them in parallel by emitting multiple calls in one message, pass file pointers not inlined context, and omit `delegate_task`'s `target` so the subagent inherits the parent chat model. Tier the work by scope and prompt, not by model.",
    ],
  ],
  "figure-it-out/SKILL.md": [
    [
      "Open a todolist whose first item is to invoke the **poteto-mode** skill via the skill tool and read the Principles section.",
      "Open a todolist whose first item is to read the **poteto-mode** skill's `SKILL.md` with the read tool and read the Principles section.",
    ],
  ],
  "architect/references/runner-prompt.md": [
    [
      "Invoke the **architect** skill via the skill tool in full first;",
      "Read the **architect** skill's `SKILL.md` with the read tool first;",
    ],
  ],
  "poteto-mode/playbooks/multi-phase-plan.md": [
    [
      "Load the technical-writing skill via the skill tool in full, then the unslop skill.",
      "Read the technical-writing skill's `SKILL.md` with the read tool in full, then the unslop skill's.",
    ],
    [
      "Call the `poteto_check_plan` tool with the plan path and fix every problem it prints (the **encode-lessons-in-structure** principle skill).",
      "Call the `poteto_check_plan` tool with the plan path (from a codemode script, as `tools.poteto_check_plan`) and fix every problem it prints (the **encode-lessons-in-structure** principle skill).",
    ],
  ],
  "automate-me/SKILL.md": [
    ["Invoke it via the skill tool for granularity.", "Read its `SKILL.md` with the read tool for granularity."],
    [
      "Locate the active workspace's session history before fanning out. Use the opencode session messages API for the current project. Use only that scope. Never read session storage from unrelated projects.",
      "Locate the active workspace's session history before fanning out. pi stores sessions as JSONL, one file per session, under `~/.pi/agent/sessions/<project-slug>/`; read only the current project's directory. Use only that scope. Never read session storage from unrelated projects.",
    ],
    [
      "Mining misses intent that hasn't come up yet. Use the `question` tool (structured multi-choice) rather than asking the user to type from scratch. Lower cognitive load, higher hit rate.",
      "Mining misses intent that hasn't come up yet. Offer a short list of concrete choices rather than asking the user to type from scratch. Lower cognitive load, higher hit rate.",
    ],
  ],
  "recall/SKILL.md": [
    [
      "Session history lives in opencode session storage for the active project. Use the session messages API scoped to the current workspace. Every entry is one chat message.",
      "Session history lives in pi's session JSONL files, one per session, under `~/.pi/agent/sessions/<project-slug>/`. Read only the current workspace's directory. Each line is one event; user and assistant messages carry the conversation.",
    ],
  ],
  "show-me-your-work/SKILL.md": [
    [
      "Read this run's session history via the opencode session API.",
      "Read this run's session history from pi's session JSONL files under `~/.pi/agent/sessions/<project-slug>/`.",
    ],
  ],
  "poteto-mode/playbooks/eval.md": [
    [
      "Read each candidate's session messages via the opencode session API in its own working dir.",
      "Read each candidate's session messages from pi's session JSONL files in its own working dir.",
    ],
    [
      "Look at which skills each candidate actually invoked via the skill tool. Citing a principle is not invoking its leaf skill via the skill tool, and invoking it is not applying it.",
      "Look at which skill files each candidate actually read with the read tool. Citing a principle is not reading its leaf skill file, and reading it is not applying it.",
    ],
  ],
  "reflect/SKILL.md": [
    [
      "The parent finds its own transcript file before fanning out. The system prompt names the active workspace's storage path; use that path. Do not glob across unrelated workspace directories.",
      "The parent finds its own transcript file before fanning out. The `PI_SESSION_FILE` environment variable names the absolute path to the current session's JSONL file; use it when set. Otherwise take the most recently modified file under this project's `~/.pi/agent/sessions/<project-slug>/` directory. Do not glob across unrelated workspace directories.",
    ],
    [
      "ls -t <agent-transcripts>/*.jsonl <agent-transcripts>/*/*.jsonl <agent-transcripts>/*/subagents/*.jsonl 2>/dev/null | head -10",
      "ls -t ~/.pi/agent/sessions/*/*.jsonl 2>/dev/null | head -10",
    ],
    [
      "Three transcript layouts: legacy flat (`<id>.jsonl`), current nested (`<id>/<id>.jsonl`), and subagent (`<parent>/subagents/<child>.jsonl`).",
      "pi stores one JSONL file per session under `~/.pi/agent/sessions/<project-slug>/`. The first line is a session header; the user and assistant messages follow, each as one event.",
    ],
    [
      "For each candidate, read the first JSONL line and check that `message.content[0].text` contains the conversation's opening user prompt. Take the matching path. If no path resolves, write a tight digest of the session and pass that instead.",
      "For each candidate, read the JSONL file and check that a user message's text contains the conversation's opening prompt. User messages carry `content` as an array of parts, so check `content[0].text`. Take the matching path. If no path resolves, write a tight digest of the session and pass that instead.",
    ],
  ],
  "poteto-mode/playbooks/session-pickup.md": [
    [
      "A local transcript under the active workspace's storage directory (the system prompt names the path; do not glob across unrelated workspace directories), or a pushed branch.",
      "A local transcript under this project's `~/.pi/agent/sessions/<project-slug>/` directory (`PI_SESSION_FILE` names the current one; do not glob across unrelated workspace directories), or a pushed branch.",
    ],
  ],
  "poteto-mode/playbooks/orchestrate.md": [
    [
      "Create `orchestrate/<project-slug>/` in the current agent's store (path in the system prompt).",
      "Create `orchestrate/<project-slug>/` in the current working directory (the store path is resolved against the session's working directory).",
    ],
    [
      "State reads and writes go through the `poteto_orch_*` tools at drain points, one call in and one line out, to conserve context. The tools never spawn, wait, or wake anything.",
      "State reads and writes go through the `poteto_orch_*` tools at drain points, one call in and one line out, to conserve context. These tools are exposed to codemode only, so call them from a codemode script as `tools.poteto_orch_*`. The tools never spawn, wait, or wake anything.",
    ],
  ],
  "no-comments/SKILL.md": [
    [
      '1. Spawn `Task` with `subagent_type: "comment-sicko"`. Pass the scope. Do not restate its rules.',
      '1. Spawn a `delegate_task` with `role: "review"` and require it to invoke the `comment-sicko` persona skill before any work. Pass the scope. Do not restate the persona\'s rules; it reads them itself.',
    ],
  ],
};

const IDIOM_PATTERNS = [
  "skill tool",
  "Task.model",
  "subagent_type",
  "`Task`",
  "Task tool",
  "Task subagent",
  "background Task",
  "a Task with",
  "`question`",
  "the system prompt names",
  "path in the system prompt",
  "opencode",
  "OpenCode",
  "agent-transcripts",
  "subagents/",
  "/poteto-mode`",
];

function listMarkdown() {
  return execFileSync("find", [SKILLS, "-name", "*.md", "-type", "f"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}

function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { front: {}, body: text };
  const front = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) front[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { front, body: m[2].replace(/^\n+/, "") };
}

function applyRules(text, rules) {
  let out = text;
  const hits = [];
  for (const [find, replace] of rules) {
    if (out.includes(find)) {
      out = out.split(find).join(replace);
      hits.push(find.slice(0, 48));
    }
  }
  return { out, hits };
}

// T3's `delegate_task` `role` is only a one-line framing prefix, never a persona
// loader, so each opencode agent persona also ships as a pi skill a delegate can
// be told to invoke. Generated from the source agents so the persona has one
// origin, with the same global rules applied to the body.
function generatePersonaSkills() {
  let made = 0;
  let agents;
  try {
    agents = readdirSync(AGENTS).filter((f) => f.endsWith(".md"));
  } catch {
    console.log(`\npersona skills: no agents at ${AGENTS}, skipped`);
    return made;
  }
  console.log("\npersona skills:");
  for (const file of agents) {
    const name = basename(file, ".md");
    const { front, body } = splitFrontmatter(readFileSync(join(AGENTS, file), "utf8"));
    const description = front.description ?? `${name} persona`;
    const raw = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
    const { out } = applyRules(raw, GLOBAL);
    const dir = join(SKILLS, name);
    const target = join(dir, "SKILL.md");
    let existing = null;
    try {
      existing = readFileSync(target, "utf8");
    } catch {}
    if (existing !== out) {
      made++;
      if (!CHECK) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(target, out);
      }
      console.log(`  ${name}/SKILL.md`);
    }
  }
  console.log(`  ${made} persona skills ${CHECK ? "would change" : "written"}`);
  return made;
}

let changedFiles = 0;
let totalHits = 0;
const missed = [];
for (const file of listMarkdown()) {
  const rel = file.slice(SKILLS.length + 1);
  const original = readFileSync(file, "utf8");
  let out = original;
  const hits = [];
  const perFile = PER_FILE[rel];
  if (perFile) {
    const first = applyRules(out, perFile);
    out = first.out;
    hits.push(...first.hits);
  }
  const second = applyRules(out, GLOBAL);
  out = second.out;
  hits.push(...second.hits);
  if (out !== original) {
    changedFiles++;
    totalHits += hits.length;
    if (!CHECK) writeFileSync(file, out);
    console.log(`  ${rel}  (${hits.length} rules)`);
  }
}

console.log(`\n${CHECK ? "would change" : "changed"} ${changedFiles} files, ${totalHits} rule applications`);

const personaChanges = generatePersonaSkills();

console.log("\nremaining idiom scan:");
let leftover = 0;
for (const file of listMarkdown()) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pat of IDIOM_PATTERNS) {
      if (lines[i].includes(pat)) {
        console.log(`  ${file.slice(SKILLS.length + 1)}:${i + 1}  ${pat}  ::  ${lines[i].trim().slice(0, 120)}`);
        leftover++;
      }
    }
  }
}
console.log(`  ${leftover} leftover lines`);

// A leftover idiom is a failure. Without this, --check exits 0 on a dirty tree
// and a caller reads green from a red run.
if (leftover > 0) process.exitCode = 1;
if (CHECK && changedFiles + personaChanges > 0) process.exitCode = 1;
