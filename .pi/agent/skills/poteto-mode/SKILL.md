---
name: poteto-mode
description: poteto's playbook router for rigorous, verified agent work. Invoke whenever the chat contains `poteto`, the user types `/skill:poteto-mode`, or asks to work in poteto's style. Match the task to one playbook, read the principle skills it triggers, write the reply unslopped.
---

# Poteto mode

## Non-negotiables

1. Open a todolist whose first item is to read the Principles index below in full.
2. Scan the index before acting. When a trigger matches, read the leaf skill's `SKILL.md` with the read tool before the work it governs. A read of the skill file in the history is the proof; a citation is not.
3. Match the task to one playbook and copy its steps into the todolist verbatim. Keep a skipped step listed as `skip: <reason>`.
4. In the reply, trace each invoked principle to the decision it changed.

## Skill invocation

Reach every skill by reading its `SKILL.md` with the read tool. Pi lists every skill's name, description, and absolute location in the `<available_skills>` block of the system prompt. Resolve a skill's directory from that block, then read `<dir>/SKILL.md`. `how` lives in the `how` skill directory and `principle-laziness-protocol` in the `principle-laziness-protocol` directory. Read the whole file; do not grep for fragments. This rule covers this file and every playbook.

## Routing

Read each target skill's `SKILL.md` with the read tool.

- Nontrivial change, architecture decision, or "are we sure?" → the **how** skill.
- A "which approach" fork → settle it by experiment before asking. Run the Prototype playbook (`playbooks/prototype.md`) when the answer is observable by running something (behavior, timing, layout, output, perf). Reserve the question for a product or preference call no experiment can settle. A read-only Investigation whose deliverable is a cited answer stays in Investigation.
- Any code → name the data shape first, then pick its structure per **principle-model-the-domain**.
- Code crossing a function boundary → the **architect** skill, parallel design exploration before implementing.
- Parallel fan-out → the **swarm** skill (coverage matrices, races, gauntlets, exploration partitions). Design or code bakeoffs → the **arena** skill.
- Contested design → the **interrogate** skill before shipping.
- Nontrivial multi-step → write the throughput checkpoint (Feature step 3).
- Any prose surface → the **unslop** skill. Authoring agent-facing prose also loads the **writing-great-skills** and **writing-for-agents** skills.
- Docs, RFCs, readmes, PR descriptions, or commit messages → the **technical-writing** skill.
- Before commit → the **deslop** skill on the diff.
- Before review → the **no-comments** skill.
- Shipping a UI, IDE, or CLI → the matching control skill in this package (**control-cli** for CLIs and TUIs, **control-ui** for browser, Electron, and web). Reproduce a bug on the same surface before fixing.
- A PR-status request ("babysit this", "get it green", "check on PR X", "anything outstanding on X") → the **Babysit** playbook (`playbooks/babysit.md`). Opening a PR does not trigger it. Declare the mode before polling.
- Landing or shipping a green stack → the **Shipping** playbook (`playbooks/shipping.md`). Nothing merges before an independent per-PR verdict; only the contiguous verified run from the root lands.
- A review-bot comment → assess it on its merits. Fix a real finding; dismiss noise with the concrete disproof.
- A broken skill mid-task → fix it in its own PR.
- Long, autonomous, or multi-phase work, or work the user reviews later ("going to bed", "trust it when i'm back") → a decision trail via the **show-me-your-work** skill.

## Principles

Scan every entry before implementation. When a trigger matches, read the leaf skill's `SKILL.md` with the read tool before acting. Done when every matching trigger has a skill-file read. No match, no read.

**Core**

- **Laziness Protocol** (**principle-laziness-protocol**). Refactoring, sizing a diff, or tempted to add abstraction, layers, or signal threading. Prefer deletion and the smallest change that solves the problem.
- **Foundational Thinking** (**principle-foundational-thinking**). Before writing logic: core types and data structures, scaffold-vs-feature sequencing, what concurrent actors share.
- **Redesign from First Principles** (**principle-redesign-from-first-principles**). Integrating a new requirement into an existing design. Redesign as if it had been foundational from day one.
- **Subtract Before You Add** (**principle-subtract-before-you-add**). Sequencing an addition, refactor, or rewrite. Remove dead weight first, then build on the simpler base.
- **Minimize Reader Load** (**principle-minimize-reader-load**). Reviewing or shaping code that's hard to trace. Count layers and hidden state, collapse one-caller wrappers, shrink mutable scope.
- **Outcome-Oriented Execution** (**principle-outcome-oriented-execution**). Planned rewrites and migrations with explicit phase boundaries. Converge on the target architecture, don't preserve throwaway compatibility states.
- **Experience First** (**principle-experience-first**). Product, UX, or feature-scope tradeoffs. Choose user delight over implementation convenience.
- **Exhaust the Design Space** (**principle-exhaust-the-design-space**). A novel interaction or architectural decision with no precedent. Build 2-3 competing prototypes and compare before committing.
- **Build the Lever** (**principle-build-the-lever**). Any non-trivial work. Build the tool that does or proves it (codemod, script, generator), not by hand; the tool is the artifact a reviewer reruns.

**Architecture**

- **Model the Domain** (**principle-model-the-domain**). Writing stateful logic, or code that branches a lot or repeats a shape assumption across files. Encode the domain in a structure (state machine, typed model, table or registry, reducer, boundary, the right collection) instead of scattered conditionals.
- **Boundary Discipline** (**principle-boundary-discipline**). Wiring validation, error handling, or framework adapters. Guards at system boundaries, trust internal types, keep business logic pure.
- **Type System Discipline** (**principle-type-system-discipline**). Designing types or a signature in any typed language. Make illegal states unrepresentable, brand primitives, parse external data at boundaries.
- **Make Operations Idempotent** (**principle-make-operations-idempotent**). Designing commands, lifecycle steps, or loops that run amid crashes and retries. Converge to the same end state.
- **Migrate Callers Then Delete Legacy APIs** (**principle-migrate-callers-then-delete-legacy-apis**). Introducing a new internal API while old callers exist. Migrate and delete in one wave.
- **Separate Before Serializing Shared State** (**principle-separate-before-serializing-shared-state**). Concurrent actors might write the same file, branch, key, or object. Eliminate the sharing first.

**Verification**

- **Prove It Works** (**principle-prove-it-works**). After a task, before declaring done. Verify against the real artifact, not a proxy or "it compiles".
- **Fix Root Causes** (**principle-fix-root-causes**). Debugging. Trace each symptom to its root cause, reproduce first, ask why until you reach it.
- **Sequence Work into Verifiable Units** (**principle-sequence-verifiable-units**). Multi-step work (sweeps, migrations, runs of similar edits) and how you stack commits and PRs. Break work into small units that each end in a check, verify each before the next, and order delivery so the sequence proves itself.

**Delegation**

- **Guard the Context Window** (**principle-guard-the-context-window**). Context fills up: large outputs, long files, repeated reads, fan-out planning. Route bulk to subagents, keep summaries in the main thread.
- **Never Block on the Human** (**principle-never-block-on-the-human**). Tempted to ask "should I do X?" on reversible work. Proceed, present the result, let the human course-correct.

**Meta**

- **Encode Lessons in Structure** (**principle-encode-lessons-in-structure**). You catch yourself writing the same instruction a second time. Encode it as a lint, metadata flag, runtime check, or script instead of more text.

## Autonomy

**Just do it.** Use any MCP tool. Reversible work and external actions (team chat, ticket updates, kicking off evals) proceed without asking.

**Always pause** for irreversible writes: force-push to shared branches, deploys, data deletion, customer messages.

**Session overrides:** "Don't stop" / "going to bed" / "run until done" / "be fully autonomous" → keep going.

**No is an acceptable answer.** Asked whether to do something, invited to add scope, or shown an approach, reply with your real judgment. Decline, push back, or say "this doesn't earn its place" when true. A recommendation is a judgment, not a validation. Candor over agreement.

## Subagents

**Use `role: "implementation"` on `tools.mcp__t3_code__delegate_task` for any subagent you spawn inside a playbook step** (code-writing delegates, ad-hoc helpers), and require each to invoke the `poteto-agent` persona skill before any work. Routed workflow skills (`how`, `why`, `interrogate`, `reflect`, `swarm`) name their own `role` for independent review; respect what the skill prescribes. `tools.mcp__t3_code__delegate_task` is provided by T3; it exists only when pi runs inside a T3 thread. T3's `role` is a one-line framing prefix only, never a persona loader, so a persona travels as a skill the child reads.

**Defaults for every `tools.mcp__t3_code__delegate_task` call.** Run them in parallel by emitting multiple calls in one message, pass file pointers not inlined context, and omit `tools.mcp__t3_code__delegate_task`'s `target` so the subagent inherits the parent chat model. Tier the work by scope and prompt, not by model.

You own every subagent's work. Review the diff and write your own summary, don't pass through what it said. Fire a fresh subagent with consolidated scope rather than resuming an interrupted one, which silently drops directives. A second opinion is the same prompt in an independent subagent. Agreement is high-signal.

## Writing the reply

Write the reply clean as you draft it. A cleanup pass afterward does not work. Reply prose follows the **unslop** skill.

- Frame the consumer and the maintainer first. Name who the work is for and what changes for them, then what the next engineer inherits. If you can't say what either would notice, the work or the explanation is off.
- Keep every section the playbook's reply names: details, tradeoffs, choices, open decisions.
- Link only artifacts you produced or read this session.
- Draw the code's flow as a tree per the **text-tree-diagrams** skill. Show before and after for a refactor, with file and line footers.
- End with the PR link as `https://github.com/<owner>/<repo>/pull/<number>`.

## Comments

Write comments clean as you go; a flat "no narrating comments" ban doesn't catch them. The recurring case is a verify or test script that narrates its phases, a `// Phase 1: add cards` line above the block. Delete it; the assertion or log string is the only doc you need. Write `assert(ok, 'persisted across restart')`, not a `// move the card` comment plus the code. This applies to every file you produce, including a delegate's diff and the verify script. Keep a comment only for a non-obvious *why* the code can't show.

## Playbooks

Match the task to one playbook, open its file, and copy its steps into the todolist verbatim before any task-specific todos and before you reason about the task. The failure mode is reading a playbook then writing a bespoke plan that drops its named steps (`architect`, the throughput checkpoint). A step you choose not to do stays in the list with a one-line `skip: <reason>`.

A large or cross-cutting effort (a migration across many call sites, an ambitious multi-part change), or work the user steps away from to trust later, routes to the **figure-it-out** skill even when a narrower playbook like Feature fits. Use **figure-it-out** whenever no bundled playbook fits; it designs a bespoke, rigorous playbook for the task. A standing project-scale program (multi-day, many stacked PRs, a fleet of subagents under one coordinator) routes to **Orchestrate** instead.

- **Investigation.** Read-only question: how does X work, why was Y built this way, are we sure about Z, should we do X or Y. `playbooks/investigation.md`.
- **Bug fix.** A reported defect to reproduce, root-cause, and fix with runtime evidence. `playbooks/bug-fix.md`.
- **Perf issue.** A measured slowness to trace and improve against a baseline. `playbooks/perf-issue.md`.
- **Hillclimb.** Sustained, scientific improvement of one metric against a target: loop hypotheses with before/after measurement, a decision log, and one commit per accepted win. Distinct from Perf issue, which is a one-off fix. `playbooks/hillclimb.md`.
- **Runtime forensics.** Diagnose a runtime symptom (leak, idle-CPU spin, glitch) from live instrumentation. The deliverable is a diagnosis, not a fix. `playbooks/runtime-forensics.md`.
- **Trace forensics.** Diagnose a captured profiling artifact (cpuprofile, trace, spindump, heap snapshot) handed to you after the fact. The deliverable is a diagnosis, not a fix. `playbooks/trace-forensics.md`.
- **Feature.** New or changed behavior, built from a named data shape. `playbooks/feature.md`.
- **Refactoring.** A behavior-preserving change to structure or shape (rename, extract, inline, dedupe, move). `playbooks/refactoring.md`.
- **Prototype.** A throwaway sketch to make a design or behavioral decision cheaply, or to settle an empirical fork by observing it instead of asking the human ("prototype", "mock it up", "try this layout", "sketch it to decide"). `playbooks/prototype.md`.
- **Visual parity.** Pixel-exact UI equivalence: matching two implementations or migrating a styling system. `playbooks/visual-parity.md`.
- **Authoring or modifying a skill.** Writing or editing a SKILL.md. `playbooks/authoring-a-skill.md`.
- **Eval.** Testing how a skill, structure, or prompt change affects agent behavior before promoting it. `playbooks/eval.md`.
- **Babysit.** Driving a PR or a stack to merge-ready: conflicts, review threads, CI. `playbooks/babysit.md`.
- **Shipping.** The half after Babysit. Independently verifying a green stack, then landing the contiguous verified run from the root. `playbooks/shipping.md`.
- **Autonomous run.** A long task to drive to completion without stopping ("run until done", "loop until X via the autonomous-run playbook"). `playbooks/autonomous-run.md`.
- **Orchestrate.** A standing project handed to one coordinator chat: multi-day, many stacked PRs, dozens to hundreds of subagents, minimal human turns ("run this whole project", "own this migration until it lands"). Distinct from Autonomous run, which drives one task to a predicate; work one agent could finish inside the session's budget routes there, not here. `playbooks/orchestrate.md`.
- **Autopilot-full.** A queue of independent PRs run to merged with full autonomy: one owner per PR carries build through merge, and the root swarm-verifies each merge-ready head before its owner merges ("autopilot this queue", "full autopilot", one-owner-per-PR programs). `playbooks/autopilot-full.md`.
- **Autopilot-stack.** A queue of changes built and verified with full autonomy, delivered as one linear reviewed stack the operator lands herself ("autopilot-stack", "stack them, don't ship", "build the stack, I'll land it"). `playbooks/autopilot-stack.md`.
- **Session pickup.** Resuming or taking over a prior agent's in-flight work from a transcript or pushed branch. `playbooks/session-pickup.md`.
- **Pause safely.** Suspending in-flight work cleanly so it can be resumed, on an explicit pause, going offline, or imminent context compaction. The complement to Session pickup. `playbooks/pause-safely.md`.
- **Multi-phase or multi-PR plan.** Work that spans phases or stacked PRs. `playbooks/multi-phase-plan.md`.
- **Worktree and simulator cleanup.** Reclaiming local disk by pruning merged or abandoned git worktrees and stale iOS simulators ("what's using my disk", "clean up worktrees", "prune safe-to-prune worktrees", "free up space", "delete old simulators"). `playbooks/worktree-cleanup.md`.
- **Opening a PR.** Invoked at the end of every other playbook. `playbooks/opening-a-pr.md`.
