#!/usr/bin/env node
// End-to-end verification of the todos pi@1 port.
// Boots pi headless and asserts the extension loads, the tool runs, and the
// unit suite is green. Run: node .pi/agent/todos-port/verify.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/kevin/Repositories/dotfiles";
const EXT = join(REPO, ".pi/agent/extensions/todos");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

function pi(args) {
  return execFileSync("pi", args, {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180000,
  });
}

// 1. Every expected module is present.
const MODULES = [
  "index.ts", "config.ts", "tracker.ts", "state.ts", "execute.ts",
  "format.ts", "persistence.ts", "prompts.ts", "types.ts",
  "package.json", "tsconfig.json",
  "test/state.test.ts", "test/persistence.test.ts", "test/tracker.test.ts",
  "test/config.test.ts", "test/smoke.test.ts", "test/helpers.ts",
  "skills/todo-discipline/SKILL.md",
];
const missing = MODULES.filter((m) => !existsSync(join(EXT, m)));
check("all port modules present", missing.length === 0, missing.join(", "));

// 2. The dropped surfaces are gone: no TUI/render/command module, no
//    registerCommand, no render hooks, no notification emission.
const dropped = [
  "render.ts", "command.ts", "markdown.ts", "notifications.ts",
  "test/render.test.ts", "test/command.test.ts",
  "test/markdown.test.ts", "test/notifications.test.ts",
];
const stillThere = dropped.filter((m) => existsSync(join(EXT, m)));
check("dropped modules absent", stillThere.length === 0, stillThere.join(", "));

const indexSrc = readFileSync(join(EXT, "index.ts"), "utf8");
check("index.ts registers no command", !/registerCommand/.test(indexSrc));
check("index.ts has no render hooks", !/renderCall|renderResult/.test(indexSrc));
check("index.ts has no desktop-notify emission", !/desktop-notify|deriveTodoNotifications/.test(indexSrc));

// 3. The unit suite is green.
// 3. The unit suite is green. bun writes its summary to stderr, so use
//    spawnSync to capture both streams regardless of exit code.
const testRun = spawnSync("bun", ["test"], { cwd: EXT, encoding: "utf8" });
const testOut = `${testRun.stdout ?? ""}${testRun.stderr ?? ""}`;
const testOk = testRun.status === 0 && /0 fail/.test(testOut);
const passCount = (testOut.match(/(\d+) pass/) ?? [])[1] ?? "?";
check("bun test green", testOk, `${passCount} pass`);

// 4. Typecheck is clean.
let tscOk = false;
try {
  execFileSync("tsc", ["--noEmit"], { cwd: EXT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  tscOk = true;
} catch {
  tscOk = false;
}
check("tsc --noEmit clean", tscOk);

// 5. Live pi run: the tool executes init/start/done end to end.
let liveOut = "";
try {
  liveOut = pi([
    "--print", "--no-session",
    "Call the todo tool with op=init and items=[\"alpha\",\"beta\"], then op=start task \"alpha\", then op=done task \"alpha\". Reply with exactly PORT_VERIFY_OK.",
  ]);
} catch (error) {
  liveOut = String(error.stdout ?? error);
}
check("live pi: no load failure", !/Failed to load extension/.test(liveOut));
check("live pi: tool ran", /PORT_VERIFY_OK/.test(liveOut));

// 6. The bundled skill is advertised in the system prompt.
let jsonOut = "";
try {
  jsonOut = pi(["--print", "--no-session", "--mode", "json", "Reply with exactly SKILL_OK"]);
} catch (error) {
  jsonOut = String(error.stdout ?? error);
}
check("todo-discipline skill advertised", /todo-discipline/.test(jsonOut));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
