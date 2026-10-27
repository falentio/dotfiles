# Background compaction for pi

An extension that writes the compaction summary at the threshold, then compacts as soon as the agent is idle. The next prompt runs on the compacted context, and the user never waits for a summary.

Frozen contract: [SPEC.md](./SPEC.md). This file carries the investigation, the reasoning, and the build order. Where the two disagree, SPEC.md wins.

## What pi does today

`shouldCompact(tokens, window, settings)` goes true at `window - reserveTokens`. The agent loop then stops, calls `generateSummary`, waits for the reply, appends a `CompactionEntry`, and continues. The user waits for that summary.

The `session_before_compact` hook runs before pi generates its own summary, and its result replaces the whole summary step, including `firstKeptEntryId`. That hook is the seam this extension uses. Nothing in pi needs to change.

## What opencode does

Opencode (`packages/core/src/session/compaction.ts`) forks a summary fiber at 85% of its compaction ceiling, once the measured prompt passes 64k tokens. The fiber summarizes everything before the newest measured assistant message and parks the result. When compaction becomes due it joins the fiber, bills its usage, and returns the parked summary. A parked summary is discarded when the history start, the model, or the instructions changed, or when the tail since its anchor grew past `min(max(2 × keep, 30k), 25% of ceiling)`. Failures get two attempts per compaction cycle. Two details make it work:

1. The summary covers a prefix fixed at precompute time, and the pinned `firstKeptEntryId` keeps the rest verbatim. Correctness does not depend on pi's threshold landing at the same cut point.
2. The summary request sends the whole conversation plus the summary prompt, so the provider's prompt cache covers most of it.

This plan keeps both, and adds one step opencode leaves out: it calls `ctx.compact()` itself once the summary is ready, instead of waiting for the threshold. Pi only checks the threshold when a turn starts, so an idle session would otherwise sit above the line until the user types.

The summary prompt is pi's own, not opencode's, so a precomputed summary is indistinguishable from a blocking one.

## Flow

```text
agent_settled [1]
├── advance() [1a]
│   ├── if not idle or pending messages: return [1a1]
│   ├── ready and still valid: ctx.compact() [1a2] ← proactive compaction
│   ├── ready but stale: drop, return [1a3] ← pi's threshold takes over
│   ├── gate crossed and branch grew since last compaction: start summary [1a4]
│   └── otherwise: return [1a5]
└── summary done [1b]
    ├── state = ready [1b1]
    └── advance() again [1b2] ← compacts immediately when already idle

session_before_compact [2] ← reason "manual", fired by our own ctx.compact()
├── judge(precompute, preparation, branch) [2a]
│   └── skip: instructions, model, baseline, branch, tail, size [2a1]
└── use: return summary + pinned keepEntryId [2b] ← pi skips its summarize call
```

1. `agent_settled` is the only entry point. Pi will not continue on its own, the editor text is untouched, and no message can land between the summary finishing and the compaction.
2. Reason `"manual"` is expected here. The hook treats a manual compaction with no custom instructions as usable, so a user `/compact` also lands instantly on a ready summary.

## Compaction timing

The gate is a fraction of pi's ceiling, `0.85 × (window - reserveTokens)`, and it only applies when the ceiling is at least 64k. Crossing it does not compact anything by itself. It starts the summary. Compaction happens when the summary is ready and the agent is idle.

That leaves three guards the flow has to carry:

- **One compaction per stretch of work.** After compaction, the branch holds the compaction entry and the kept tail. If that is still above the gate, `advance()` must not compact again. It requires a user message after the latest compaction entry before starting another summary.
- **Idle recheck.** `ctx.compact()` aborts the current agent operation. The call is deferred out of the event handler with `setTimeout(0)` and re-checks `ctx.isIdle()` and `hasPendingMessages()` first, so a fast next prompt is never cancelled.
- **Stale summary.** If the branch grew past the tail bound while the summary was being written, drop it and leave compaction to pi's threshold. Compacting on a stale summary would either lose messages or come back still too large.

## What survives the cutoff

`keepEntryId` is a hard split, fixed when the summary starts.

- The summary covers `[last compaction boundary, keepEntryId)`. Nothing after `keepEntryId` is summarized.
- Every entry from `keepEntryId` to the branch head stays verbatim, including messages appended after the precompute finished.
- The pinned `firstKeptEntryId = keepEntryId` is what makes that true. Pi rebuilds the context as the summary message plus every message from that entry onward.
- If the tail grows past `tailLimit`, the summary is dropped and pi compacts at its threshold with a fresh cut at `keepRecentTokens` from the head. The tail then shrinks to pi's normal size.
- The next compaction starts summarizing at this compaction's `firstKeptEntryId`, so the pinned tail is folded into the next summary. No message stays outside a summary forever.

So the window after compaction is:

```text
system prompt
summary of the prefix
tail from keepEntryId ← about 20k, larger if the session grew after the precompute
```

In the common path the tail is exactly the `keepRecentTokens` window pi would have kept at threshold. Our compaction keeps slightly more, never less.

The summary input is `plan.messages`, the prefix only. Pi serializes it into one `<conversation>` text block and clips each tool result to 2,000 characters, so the request does not share the main request's prompt-cache prefix. That is the same input a blocking compaction sends. The difference is timing, not cost.

## Module shape

Four source files:

- `config.ts`: validated literals and derived limits.
- `boundary.ts`: pure cut planning, `planPrecompute` and `tailTokensFrom`.
- `state.ts`: the `Precompute` union, `judge`, `advance`.
- `index.ts`: events, the background call, the deferred `ctx.compact()`, the status line, `/precompute`.

Exported types and signatures are frozen in [SPEC.md](./SPEC.md) section 6. `boundary.ts` and `state.ts` take no `ctx` and do no I/O.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Compaction timing | `ctx.compact()` when the summary is ready and the agent is idle | Context drops before the next prompt. Pi only checks its threshold at turn start, so waiting means the next prompt pays. |
| Summary source | pi's `generateSummaryWithUsage` | Same format as a blocking compaction, reuses the update prompt, no prompt to maintain. |
| Cut point | `findCutPoint` over the last compaction's boundary | Public API, identical rules to `prepareCompaction`. The oracle test pins the copy. |
| Start trigger | `agent_settled` only | The branch cannot change between the gate check and the compaction, so a ready summary is never stale in the common path. |
| Swap boundary | Pin our own `keepEntryId` as `firstKeptEntryId` | Correct when pi's threshold lands on a different cut. The tail bound keeps the result inside the window. |
| Stale summary | Drop and let pi compact at its threshold | A stale summary either loses messages or comes back still too large. |
| Manual `/compact` | Use a ready summary when there are no custom instructions | The same span, no extra call, instant. |
| Persistence v1 | Memory only | A restart recomputes. The session entry is a later phase with its own test. |
| Settings source | `config.ts` only | Repo convention from commit 6741800. |

Config fields, defaults, and validation are frozen in [SPEC.md](./SPEC.md) section 3. `compactWhenReady: false` keeps the precompute and only hands it to pi at the threshold, which degrades to opencode's behavior.

## Phases

Each phase ends green before the next starts.

### Phase 1. Scaffold

Files: `package.json`, `tsconfig.json` (copy `../todos/tsconfig.json`), `config.ts`, `index.ts` stub, `README.md`.

Check: `bun run test` runs, `bun run typecheck` passes, and `discoverAndLoadExtensions` over the directory returns no errors.

### Phase 2. Boundary planner

Files: `boundary.ts`, `test/boundary.test.ts`.

The implementation follows `prepareCompaction`: find the last compaction, start at its `firstKeptEntryId` (or the entry after it when the id is missing), run `findCutPoint`, convert the span with `sessionEntryToContextMessages`.

Check: a table of fixtures (empty, one turn, many turns, after a compaction, keep larger than history, cut inside a turn) where our `keepEntryId` equals pi's `firstKeptEntryId` from `prepareCompaction`, and our covered message count equals pi's `messagesToSummarize.length + turnPrefixMessages.length`. A split turn is one summary for us, two merged summaries for pi, so only the union and the boundary can be compared. Load pi's function from the installed package's `dist/core/compaction/compaction.js` with `import.meta.resolve`. This is the drift guard.

### Phase 3. State machine and judge

Files: `state.ts`, `test/state.test.ts`.

`advance()` belongs here as a pure decision function over a snapshot, returning one action:

```ts
export type Action =
  | { readonly kind: "start"; readonly plan: Plan }
  | { readonly kind: "compact" }
  | { readonly kind: "drop"; readonly reason: SkipReason }
  | { readonly kind: "wait" };
```

Check: every `SkipReason` has a test, plus `start`, `compact`, `drop`, and the no-repeat rule (no start when the latest compaction has no user message after it). Table-driven, no I/O.

### Phase 4. Wiring

Files: `index.ts`.

Events: `session_start` (reset, restore later), `agent_settled` (`advance()`), `session_before_compact` (judge and hand over), `session_compact` (clear, record the leaf), `model_select` (invalidate), `session_shutdown` (abort). `advance()` calls `ctx.compact()` through `setTimeout(0)` with an idle recheck. Status strings are frozen in [SPEC.md](./SPEC.md) section 9. One command, `/precompute`, reports state and can force a run when idle.

Check: `discoverAndLoadExtensions` clean, typecheck, and a live session compacts with no prompt after the summary completes. `verify/session.test.ts` drives that live session through `createAgentSession` and a fake provider, and asserts the timing. The status line's TUI rendering stays unverified; the PR body records it as an open gap.

### Phase 5. Integration harness

Files: `mock-provider.ts`, `verify/session.test.ts`.

A fake provider extension registers a pi-ai faux provider and scripts three things: an assistant message that calls a `bloat` tool, a tool result with a large payload, and the summary reply. The test creates a temp `agentDir` with both extensions, opens `createAgentSession({ sessionManager: SessionManager.inMemory(), resourceLoader })`, drives prompts until the gate trips, then waits.

Assertions:

1. Exactly one summary request. It finishes before `compaction_start`.
2. `compaction_start` arrives with reason `manual` and no further prompt was sent.
3. The appended compaction entry has `fromHook: true` and `firstKeptEntryId` equal to the plan's `keepEntryId`.
4. The next prompt's first request carries the summary message plus the tail.
5. With `compactWhenReady: false`, no compaction happens until the threshold, and then `fromHook` is true.
6. With the extension disabled, the same script produces `fromHook: false` and a summary request after `compaction_start`.

Check: `bun run test verify` passes. This test is the lever: it proves the timing, not the intent.

### Phase 6. Persistence (optional)

Write a `precompute` custom entry when a summary is ready; restore it on `session_start` when its covered ids are still the branch prefix and no compaction follows it.

Check: reopen the session file in a second process, let the agent settle, and confirm the compaction uses the stored summary with zero summary requests.

Decided after Phase 5: skipped. A stored summary needs a `precompute` custom entry, a restore path that revalidates the covered ids on load, and a second-process test that reopens the session file. That cost is out of scope for v1 ([SPEC.md](./SPEC.md) §1), so persistence stays a later phase with its own test.

### Phase 7. Docs and PR

README covers the gates, the proactive compaction, the skip reasons, and the command. Then the Opening a PR playbook.

## Risks

- `ctx.compact()` aborts the current agent operation. The call is deferred and re-checks idle state; the integration test covers a prompt queued during the summary.
- Pi adds validation for a foreign `firstKeptEntryId`. Today `appendCompaction` accepts it and `buildSessionContext` falls back when it cannot resolve. The integration test pins the behavior.
- The boundary copy drifts from `prepareCompaction`. The oracle test in Phase 2 catches it.
- A compaction entry appears without a user turn. That is the feature; the transcript marker and the lower token count are the visible effect. Say so in the README.
- The user changes `compaction.reserveTokens` in pi settings. Our ceiling then differs from pi's. Consequence: we compact early or late, never incorrectly.
- A background summary in flight when the agent exits. `session_shutdown` aborts the controller.
