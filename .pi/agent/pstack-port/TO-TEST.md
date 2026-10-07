# pstack port to pi: what still needs testing

The port is installed at `/home/kevin/.pi/agent`. Everything that can be proven without T3 is proven by `pstack-port/verify.mjs`. This file lists the checks that need a live T3 thread, because they depend on the T3-injected `delegate_task` tool.

## Why these are deferred

`delegate_task` is provided by t3codes and auto-injected when pi runs through a T3 thread. It does not exist in a plain `pi` invocation. So a headless `pi --print` run cannot exercise it. Run these checks by opening pi through t3code and asking the agent to perform them.

## Checks that need a T3 thread

### 1. `delegate_task` exists and is callable

Ask the agent to call `delegate_task` directly with a trivial task, for example `task: "Reply with exactly the token DELEGATE_OK"`.

Pass when the tool result contains `DELEGATE_OK`.

### 2. Parallel fan-out works from one message

Ask the agent to emit three `mcp__t3-code__delegate_task` calls in a single message, each returning a distinct token.

Pass when all three tokens come back.

### 3. Async mode wakes the parent

Ask the agent to call `mcp__t3-code__delegate_task` with `mode: 'async'` and a short task, then end its turn.

Pass when the parent thread is woken by the completion and reports the child result without polling.

### 4. The `role` parameter selects a persona

Ask the agent to delegate with `role: 'review'` and a comment-cleanup task scoped to a file.

Pass when the child behaves as the comment-hater persona. T3's `role` does not load `agents/comment-sicko.md`, so the pass now requires the delegate prompt to name the `comment-sicko` persona skill.

### 5. Model inheritance and override

Ask the agent to delegate once with `target` omitted and once with an explicit `target.model`.

Pass when the first child runs on the parent model and the second runs on the named model.

### 6. The skills' `delegate_task` prose matches the real descriptor

Open `skills/swarm/SKILL.md`, `skills/arena/SKILL.md`, `skills/interrogate/SKILL.md`, and `skills/reflect/SKILL.md`. Each tells the model to call `mcp__t3-code__delegate_task` with `role` and to omit `target` for model inheritance.

Pass when those calls work as written against the real T3 tool. If the T3 descriptor uses different parameter names, update `pstack-port/adapt-skills.mjs` and re-run it.

## Open question: do the agent personas load automatically

The port ships `agents/general.md`, `agents/poteto-agent.md`, and `agents/comment-sicko.md`. These are the source plugin's registered agents.

The T3 descriptor names a `role`, not an agent file. It is unknown whether T3's `delegate_task` reads `~/.pi/agent/agents/*.md`.

Test it this way. Delegate with `role: 'review'` and a task that would trigger the comment-sicko voice. If the child answers in that voice, T3 loads the persona files. If it does not, the parent must reach the persona another way. **Result: it does not.** Each persona now ships as a skill (`skills/comment-sicko/SKILL.md`, `skills/poteto-agent/SKILL.md`), and the delegate prose requires the child to invoke it.

## Checks already proven without T3

`node pstack-port/verify.mjs` proves all of these against the real pi binary:

- 51 skills on disk and 51 advertised by pi (49 source skills plus the two generated persona skills).
- No opencode idioms left in skill prose.
- 25 `poteto_*` tools registered and callable from codemode.
- The `/poteto-mode` prompt template loads.
- The three agent files exist.
- The extension files exist and load without error.

Two live proofs ran headless and passed. A session read `poteto-mode/SKILL.md` at the pi-advertised path and routed a memory-leak prompt to `runtime-forensics.md`. A session read `how/SKILL.md` and resolved its `references/explorer-prompt.md` to an absolute path.

## Caveat: several pstack copies exist on this machine

This machine holds more than one copy of these skills, including `/home/kevin/Repositories/opencode-pstack/skills`, a superpowers worktree, and a grok plugin copy. pi advertises only the installed copy at `/home/kevin/.pi/agent/skills/<name>/SKILL.md`.

A model that globs for `poteto-mode/SKILL.md` instead of reading the advertised location can land on a stale source copy and follow the unadapted prose. The adapted prose tells the model to resolve the skill from the `<available_skills>` block, so a well-behaved run reads the installed copy. Watch for this if a run behaves as if the opencode idioms were still present.

If the extra copies are not needed, removing them removes the ambiguity.

## Results (run on T3 thread `9d23c24d-25e4-40d0-aa4c-cabef8211d9d`)

Parent model `9Router/deepseek` via provider instance `pi`. Every verdict was read from the child's own thread or result, not a self-report.

### 1. `delegate_task` exists and is callable. VERIFIED.

The tool is registered as `mcp__t3-code__delegate_task` (model-facing) and `mcp__t3_code__delegate_task` (API). A call with `task: "Reply with exactly the token DELEGATE_OK"` returned `latestTerminalSummary: DELEGATE_OK`, `providerInstanceId: pi`, `model: 9Router/deepseek`.

### 2. Parallel fan-out from one message. VERIFIED.

Three calls in a single message returned `FANOUT_ALPHA`, `FANOUT_BRAVO`, `FANOUT_CHARLIE`, each in `mode: wait`, all on the inherited model.

### 3. Async mode wakes the parent. VERIFIED for delivery, with a caveat.

`mode: 'async'` with `task: "Reply with exactly the token ASYNC_WAKE_OK"`. The completion arrived as a thread wake carrying `ASYNC_WAKE_OK` with no polling. Caveat: the wake landed mid-turn while the parent was still working, not on an idle thread, because the parent did not end its turn. T3's descriptor says an async completion "wakes this thread through a notification, steered into active turns where supported or queued otherwise". So delivery is proven; the idle-wake path the playbook prose relies on was not exercised. A run that truly ends its turn before the wake would confirm the idle path.

### 4. The `role` parameter selects a persona. NOT VERIFIED.

`role: 'review'` injected only the generic framing `Act as the review sub-agent for this task.` into the child's `task` prompt. The child's transcript shows a generic security review (SHA-256, timing attacks), never the comment-sicko voice. The persona file `agents/comment-sicko.md` was never loaded. Re-run with the persona inlined into the `task` prompt produced the full sicko report (11 deletions, `MUST KILL` flags), which confirms the fix and the failure of `role`.

### 5. Model inheritance and override. VERIFIED.

With `target` omitted the child ran on `9Router/deepseek` (the parent model). With `target: { providerInstanceId: "pi", model: "9Router/glm" }` the child ran on `9Router/glm`.

### 6. The skills' `delegate_task` prose matches the real descriptor. NOT VERIFIED, fixed.

The prose said to call `delegate_task`. That bare name is not registered; a literal call of it returned `Tool delegate_task not found`. pi resolves tool names exactly and registers no alias. The real names are `mcp__t3-code__delegate_task` (model-facing, hyphen) and `mcp__t3_code__delegate_task` (API, underscore). A capable model reading its tools block can bridge the prose name to the real one, so the bare name was inconvenient rather than fatal, but it is wrong and it cost the model a wasted call. `swarm`, `arena`, `interrogate`, `reflect`, and the other 20 files were rewritten by the codemod to name `mcp__t3-code__delegate_task`. `verify.mjs` now fails if a bare reference returns.

### Open question: do the agent personas load automatically. NO, and the fix is persona skills.

T3's `role` is a one-line framing prefix only. Each persona also ships as a pi skill generated from the source agent by the codemod: `skills/comment-sicko/SKILL.md` and `skills/poteto-agent/SKILL.md`. The delegate prose now reads "spawn a subagent with `role: ...` and a required invocation of the persona skill" instead of `subagent_type: ...`. Verified live: a `role: 'review'` child told to invoke the `comment-sicko` persona skill read `/home/kevin/.pi/agent/skills/comment-sicko/SKILL.md` from its `<available_skills>` block and returned the full sicko report (deletions, `MUST KILL`, the leash framing).

Skill count rises from 49 to 51. All 51 are advertised, so every turn carries two more descriptions.

### Extra findings

- `autonomous-run.md` put a PR watch on a subagent. T3 forbids a subagent watching a PR, so the watch was moved to the parent thread, which owns it.
- The personas are not loadable through `role`, so each ships as a skill and the delegate prose requires the child to invoke it.
- The codemod was not idempotent: a second run corrupted `orchestrate.md` by re-applying one rule. It now reads source text and is a no-op on adapted text; `PSKILLS_DIR` lets it run against a fresh source copy, and it generates the persona skills.

### Summary table

| # | Check | Verdict |
|---|---|---|
| 1 | `delegate_task` callable | VERIFIED |
| 2 | Parallel fan-out | VERIFIED |
| 3 | Async wake | VERIFIED for delivery (mid-turn caveat above) |
| 4 | `role` selects a persona | NOT VERIFIED, personas ship as skills |
| 5 | Model inheritance and override | VERIFIED |
| 6 | Skill prose matches the descriptor | NOT VERIFIED, fixed |
| Q | Personas load automatically | NO, persona skills instead |

