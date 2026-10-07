# Continue the pstack -> pi port, on t3code

**Status: done.** The six T3 checks ran on thread `9d23c24d-25e4-40d0-aa4c-cabef8211d9d`, the two failures were fixed in the codemod, and `verify.mjs` passes 15/15. Results are in `TO-TEST.md`; the decision trail is in `decisions.tsv` (rows from `2026-10-07T10:19:15Z` on). The notes below are the original brief, kept for context.

---

Continue a finished port. Do not redo it. Verify it on this T3 thread, fix what the T3 tool boundary breaks, and close the loop.

## Context

The opencode plugin `@falentio/opencode-pstack` (pstack) was ported to this pi install at `/home/kevin/.pi/agent`. The port is installed and passes its own 10-check suite. What remains is the part that needs a live T3 thread, because it depends on the T3-injected `delegate_task` tool.

Read these first, in order:

- `/home/kevin/.pi/agent/pstack-port/decisions.tsv` — the decision trail, one row per choice.
- `/home/kevin/.pi/agent/pstack-port/TO-TEST.md` — the six T3 checks and the open question.
- `/home/kevin/.pi/agent/skills/poteto-mode/SKILL.md` — the router. Work in its style for this task.

Source of truth for behavior is `/home/kevin/Repositories/opencode-pstack`. The port must match it, except where pi has no equivalent.

## What is already done

- 49 skills in `/home/kevin/.pi/agent/skills/`, prose adapted from opencode idioms to pi. `pstack-port/adapt-skills.mjs` is the codemod that produced them.
- 25 `poteto_*` tools in `/home/kevin/.pi/agent/extensions/pstack/`, registered as codemode tools. Called as `tools.poteto_orch_*` from a codemode script.
- Three agent personas in `/home/kevin/.pi/agent/agents/`: `general.md`, `poteto-agent.md`, `comment-sicko.md`.
- A `/poteto-mode` prompt template.
- `pstack-port/verify.mjs` — 10 checks against the real pi binary, all passing.

## What you are here to do

### 1. Run the six T3 checks in `TO-TEST.md`

Each has a pass predicate. Record each as VERIFIED, NOT VERIFIED, or INCONCLUSIVE with the evidence. Do not mark a check passed on a self-report; inspect the child result.

### 2. Answer the open question: does T3's `delegate_task` load the persona files

The T3 descriptor names a `role` (`implementation`, `research`, `review`, `design`, `test`, `general`). The port ships agent markdown at `~/.pi/agent/agents/*.md`. It is unknown whether T3 reads those files.

Delegate with `role: 'review'` and a task that would trigger the comment-sicko voice. If the child answers in that voice, T3 loads the personas. If not, the skills must inline the persona text into the `task` prompt instead.

### 3. Reconcile the skills' `delegate_task` prose with the real descriptor

The skills currently say to call `delegate_task` with `role`, and to omit `target` for model inheritance. Confirm those names against the live tool. The real descriptor is:

- `task` (required), `title`, `role`, `runtimeMode`, `interactionMode`, `clientRequestId`, `target` (with `providerInstanceId`, `model`, `driverKind`, `options`).
- `mode='async'` (default, wakes the parent on completion) or `mode='wait'` (blocks up to `timeoutMs`, default 10 min).
- Lifecycle helpers `task_status` and `task_cancel`.

If any name differs from the skills' prose, edit `pstack-port/adapt-skills.mjs`, re-run it (`node pstack-port/adapt-skills.mjs`), and re-run `pstack-port/verify.mjs`.

### 4. Fix the async-wake prose if needed

`autonomous-run.md`, `autopilot-full.md`, and `autopilot-stack.md` now say to run a background `delegate_task` in `mode: 'async'` and end the turn, since T3 wakes the parent on completion. That replaces the source's sleep-and-poll loop. Confirm this matches T3's real behavior. A subagent cannot watch a PR; the parent thread owns that, so any watcher prose must keep the watch in the parent.

### 5. Re-verify and hand back

Run `node pstack-port/verify.mjs` and confirm it stays green. Append a row to `decisions.tsv` for every decision you make, per the `show-me-your-work` skill format. End your reply with an "Attention" section listing what the user should still scrutinize.

## Rules

- Work in poteto-mode's style. Read the `poteto-mode` skill's `SKILL.md` first and route this task to its playbooks.
- Do not edit the 25 tool bodies unless a T3 test proves a bug. They are byte-identical to the source on purpose.
- Prefer editing the codemod over editing generated skill files, so the change is reproducible.
- Reversible work proceeds without asking. Pause only for irreversible writes.
- If a T3 test reveals the descriptor is incompatible with the ported prose, say so plainly and propose the smallest fix. Do not paper over it.

## Watch for this trap

This machine holds several copies of these skills, including `/home/kevin/Repositories/opencode-pstack/skills`, a superpowers worktree, and a grok plugin copy. pi advertises only the installed copy. A run that globs for a skill instead of reading the path pi advertises can land on a stale source copy and follow unadapted prose. Always resolve a skill from the `<available_skills>` block.
