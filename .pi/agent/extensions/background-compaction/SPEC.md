# Background compaction: frozen specification

Version 1.2, freeze candidate. On approval this becomes the implementation contract. After that, anything marked FROZEN needs a version bump and an update to the tests that name it.

Changes in 1.2, found in review of the 1.1 draft: §4.2 returns undefined when the branch ends with a compaction entry, as `prepareCompaction` does; §10.1 gains that fixture.

Changes in 1.1, found while implementing: `Limits` carries `enabled` and `compactWhenReady`; boundary planning skips compaction entries and zero-message entries; `/precompute` reports through `ui.notify` because command handlers return void; the state stays `ready` while `ctx.compact()` runs, and only an extension-issued compaction flips it to `compacting`.

Companion documents: [PLAN.md](./PLAN.md) for the investigation, the flow, and the build order.

## 1. Scope

An extension for pi that summarizes the prefix of a session at a ratio gate, holds the summary, and compacts the session as soon as the agent is idle. The compaction is recorded by pi as a normal `CompactionEntry`, so `/tree`, the footer token count, and session reload keep working.

Out of scope: a custom summary prompt, persistence across process restarts, per-model overrides, changes to pi's threshold behavior, and any UI beyond a status line and one command.

## 2. Behavior contract

FROZEN. These are the user-visible promises.

1. Once a session's estimated context reaches the gate, the extension writes a summary while the agent is idle.
2. When the summary is ready and the agent is idle with no pending messages, the extension compacts the session without waiting for the user's next prompt.
3. The compaction covers the same span a blocking compaction would: the summary replaces everything before the cut, and every message from the cut to the branch head stays verbatim.
4. A summary that can no longer describe the branch is discarded. The extension then does nothing and pi's threshold compaction takes over.
5. A user `/compact` without custom instructions uses a ready summary when one is valid, so it completes without a summary call.
6. With the config disabled, the extension makes no summary call, no compaction call, and no status write.
7. With `compactWhenReady: false`, the extension still writes summaries but never calls `ctx.compact()`. Pi's threshold compaction then consumes the summary through the hook.

## 3. Configuration

FROZEN field names and defaults. `config.ts` is the only settings source; no settings file, environment variable, or flag is read.

```ts
export const PRECOMPUTE_CONFIG = {
  enabled: true,
  compactWhenReady: true,
  compactAtRatio: 0.85,
  minCeilingTokens: 64_000,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  tailShare: 0.25,
  tailMin: 30_000,
  maxFailures: 2,
} as const;
```

Validation runs once at module load and throws on violation.

| Field | Rule |
| --- | --- |
| `compactAtRatio` | number, `0 < x <= 1` |
| `minCeilingTokens` | integer, `>= 1` |
| `reserveTokens` | integer, `>= 0` |
| `keepRecentTokens` | integer, `>= 1` |
| `tailShare` | number, `0 < x <= 0.5` |
| `tailMin` | integer, `>= 0` |
| `maxFailures` | integer, `>= 0` |

Derived values use integer token counts:

```text
ceiling(window)   = window - reserveTokens
gate(ceiling)     = compactAtRatio * ceiling
tailLimit(ceiling) = min(max(2 * keepRecentTokens, tailMin), tailShare * ceiling)
```

`reserveTokens` mirrors pi's default. When pi's `compaction.reserveTokens` differs, the gate and the tail limit shift by the difference. The result is an earlier or later compaction, never an incorrect one.

## 4. Decisions

### 4.1 Gate

FROZEN. A summary may start only when all hold:

1. `enabled` is true.
2. `ctx.getContextUsage()` returns a usage with a non-null `tokens`.
3. `ceiling = contextWindow - reserveTokens` is at least `minCeilingTokens`.
4. `tokens >= compactAtRatio * ceiling`.

The `minCeilingTokens` check is a floor on the window, not on the usage. A model whose ceiling is under 64k never precomputes, because the summary costs a full request and the saving is small.

### 4.2 Boundary

FROZEN. `planPrecompute` mirrors pi's `prepareCompaction`:

1. Return undefined when the last entry is a `compaction` entry. Pi's `prepareCompaction` refuses that branch before it cuts anything.
2. Take `entries = ctx.sessionManager.getBranch()`.
3. Find the last `compaction` entry. If one exists, `boundaryStart` is the index of its `firstKeptEntryId`; when that id is absent from the branch, `boundaryStart` is the index after the compaction entry. Otherwise `boundaryStart = 0`.
4. `cut = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens)`.
5. `keepEntryId = entries[cut.firstKeptEntryIndex].id`.
6. `messages` is the concatenation of `sessionEntryToContextMessages(entries[i])` for `i` in `[boundaryStart, cut.firstKeptEntryIndex)`, skipping compaction entries.
7. `coveredEntryIds` holds the id of every entry that contributed messages, in order. Entries that project to no messages, and compaction entries, are skipped.
8. `previousSummary` is the last compaction entry's `summary`, or undefined.
9. Return undefined when `messages` is empty or `keepEntryId` is missing.

A split turn is one summary for the extension, not two. The covered span includes pi's `turnPrefixMessages`.

`keepEntryId` is always a valid cut point: user, assistant, bash execution, or custom message. It is never a tool result.

### 4.3 Judge

FROZEN order; the first match wins. Inputs: the held precompute, the current branch, the current model reference, `customInstructions`, the current `previousSummary`, and the tail limit.

| # | Condition | Result |
| --- | --- | --- |
| 1 | status is not `ready` | skip `not-ready` |
| 2 | `customInstructions` is a non-empty string after trim | skip `custom-instructions` |
| 3 | current model reference differs from the plan's | skip `model-changed` |
| 4 | current `previousSummary` differs from the plan's (including defined versus undefined) | skip `baseline-changed` |
| 5 | `coveredEntryIds[0]` is absent from the branch | skip `branch-changed` |
| 6 | any covered id is out of order or missing from the branch | skip `branch-changed` |
| 7 | `tailTokensFrom(branch, keepEntryId)` is undefined | skip `branch-changed` |
| 8 | tail tokens exceed the limit | skip `tail-too-big` |
| 9 | otherwise | use the summary, pin `firstKeptEntryId = keepEntryId` |

The tail limit is `tailLimit(ceiling)`. For a compaction with `willRetry` true (overflow recovery), the limit is `min(tailLimit(ceiling), keepRecentTokens)`.

At the hook, the judge runs against pi's real `preparation` (`previousSummary`, `customInstructions`) and the current branch. In `advance()`, it runs against values derived from the branch. The hook's verdict is authoritative.

### 4.4 Timing

FROZEN.

- `advance()` runs on `agent_settled` and after a summary settles.
- `advance()` returns `compact` only when the agent is idle, no messages are pending, `compactWhenReady` is true, and the judge returns `use`.
- `ctx.compact()` is called from a `setTimeout(0)` callback. The callback re-checks `ctx.isIdle()` and `hasPendingMessages()` before issuing the call.
- The state stays `ready` while `ctx.compact()` runs. The hook flips it to `compacting` only when the extension issued the call, so a foreign compaction that fails leaves the summary reusable.
- A summary that completes while the agent is running stays `ready`. The next `agent_settled` acts on it.
- After a compaction completes, no new summary starts until a user message exists after the latest compaction entry.

### 4.5 Compaction reason

FROZEN. `ctx.compact()` produces `session_before_compact` with reason `"manual"` and no custom instructions. The judge does not branch on the reason. A user `/compact` with instructions is skipped by rule 2. Overflow recovery is handled by the tighter tail limit.

## 5. State machine

FROZEN states and transitions. One `SessionState` per extension instance, reset on `session_start` and `session_shutdown`.

```ts
export type Precompute =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly plan: Plan; readonly abort: AbortController }
  | { readonly status: "ready"; readonly plan: Plan; readonly summary: string; readonly usage?: Usage }
  | { readonly status: "compacting" }
  | { readonly status: "failed" };

export interface SessionState {
  readonly precompute: Precompute;
  readonly failures: number;
  readonly lastFailedKeepId: string | null;
}

export type Action =
  | { readonly kind: "start"; readonly plan: Plan }
  | { readonly kind: "compact" }
  | { readonly kind: "drop"; readonly reason: SkipReason }
  | { readonly kind: "wait" };
```

`advance()` is pure:

```ts
export function advance(
  state: SessionState,
  snapshot: Snapshot,
  limits: Limits,
): Action;

export interface Snapshot {
  readonly idle: boolean;
  readonly hasPendingMessages: boolean;
  readonly tokens: number | null;
  readonly contextWindow: number;
  readonly branch: readonly SessionEntry[];
  readonly modelRef: string | undefined;
  readonly userMessageSinceCompaction: boolean;
}
```

FROZEN decision order:

1. `enabled` false → `wait`.
2. not idle or pending messages → `wait`.
3. `running` or `compacting` → `wait`.
4. `ready`: judge. Use and `compactWhenReady` → `compact`. Use and not `compactWhenReady` → `wait`. Skip → `drop`.
5. `failed` with `failures >= maxFailures` → `wait`.
6. Gate not crossed → `wait`.
7. No user message since the latest compaction → `wait`.
8. `failures > 0` and the last failed plan's `keepEntryId` equals the plan for this branch → `wait`.
9. `planPrecompute` returns undefined → `wait`.
10. Otherwise → `start`.

Event transitions, all side effects owned by `index.ts`:

| Event | Current state | Effect |
| --- | --- | --- |
| `session_start` | any | reset to `idle`, `failures = 0`, `lastFailedKeepId = null` |
| `agent_settled` | any | `advance()` and apply the action |
| summary resolved | `running` | `ready` with summary and usage, then `advance()` |
| summary rejected, not aborted | `running` | `failures++`, `lastFailedKeepId = plan.keepEntryId`, `failed`; if under budget the next `advance()` may retry |
| summary rejected, aborted | any | ignore |
| auth or configuration failure | `running` | `failures = maxFailures`, `failed`; no retry until a compaction resets the counters |
| deferred compact callback | `ready` | idle and no pending → `ctx.compact()` while staying `ready`; otherwise stay `ready` |
| `ctx.compact()` error | `ready` | `failures++`, `failed` |
| `session_before_compact` | `ready` | judge; `use` → return the compaction and, when the extension issued the call, move to `compacting`; skip → return nothing |
| `session_compact` | any | abort any controller, reset to `idle`, `failures = 0`, `lastFailedKeepId = null` |
| `model_select` | `running` or `ready` | abort, reset to `idle` |
| `session_shutdown` | any | abort any controller, reset to `idle` |

## 6. Module API

```ts
// boundary.ts
export interface Plan {
  readonly coveredEntryIds: readonly string[];
  readonly keepEntryId: string;
  readonly messages: readonly AgentMessage[];
  readonly previousSummary: string | undefined;
  readonly modelRef: string;
  readonly tailTokens: number;
}

export function planPrecompute(
  entries: readonly SessionEntry[],
  keepRecentTokens: number,
  modelRef: string,
): Plan | undefined;

export function tailTokensFrom(
  entries: readonly SessionEntry[],
  keepEntryId: string,
): number | undefined;

// state.ts
export type SkipReason =
  | "not-ready"
  | "custom-instructions"
  | "model-changed"
  | "baseline-changed"
  | "branch-changed"
  | "tail-too-big";

export type Verdict =
  | { readonly kind: "use"; readonly summary: string; readonly firstKeptEntryId: string; readonly usage?: Usage }
  | { readonly kind: "skip"; readonly reason: SkipReason };

export function judge(input: {
  readonly precompute: Precompute;
  readonly branch: readonly SessionEntry[];
  readonly modelRef: string | undefined;
  readonly customInstructions: string | undefined;
  readonly previousSummary: string | undefined;
  readonly tailLimit: number;
}): Verdict;

export function advance(state: SessionState, snapshot: Snapshot, limits: Limits): Action;

// config.ts
export interface Limits {
  readonly enabled: boolean;
  readonly compactWhenReady: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly compactAtRatio: number;
  readonly minCeilingTokens: number;
  readonly maxFailures: number;
  readonly tail: (contextWindow: number) => number;
}
```

`boundary.ts` and `state.ts` import only types and pure functions from pi (`findCutPoint`, `sessionEntryToContextMessages`, `estimateTokens`). They take no `ctx`, open no timers, and perform no I/O.

`index.ts` owns the extension wiring: event handlers, the abort controllers, the summary call, the deferred `ctx.compact()`, the status line, and `/precompute`.

## 7. Summary call

FROZEN behavior, not frozen call syntax.

- Model: `ctx.model`. Undefined means no start.
- Auth: `ctx.modelRegistry.getApiKeyAndHeaders(model)`. `!ok` or a missing key is a hard failure.
- Call: `generateSummaryWithUsage(plan.messages, model, reserveTokens, apiKey, headers, controller.signal, undefined, plan.previousSummary, ctx.thinkingLevel)`.
- Usage is stored on the plan's result and passed back in the compaction as `usage`.
- The summary must be non-empty after trim. Empty counts as a failure.
- The request is not retried by the extension. Pi's summarizer has its own retry policy; the extension's `failures` budget covers whole-call failure.

## 8. Invariants

The test suite asserts every one.

1. `keepEntryId` is always a valid cut point, never a tool result.
2. `planPrecompute` returns the same `keepEntryId` as `prepareCompaction` for the same branch and settings.
3. The covered message count equals `messagesToSummarize.length + turnPrefixMessages.length` for the same branch and settings.
4. `advance` never returns `start` while `running`, `ready`, or `compacting`.
5. `advance` never returns `compact` unless `judge` returns `use`.
6. `advance` never returns `start` when no user message follows the latest compaction.
7. `advance` never returns `start` when `failures >= maxFailures`.
8. A rejected summary always leaves `failed`, never `running`.
9. Every abandoned controller is aborted exactly once.
10. `session_compact` resets `failures` and `lastFailedKeepId`.
11. The hook returns either nothing or a compaction whose `firstKeptEntryId` equals the plan's `keepEntryId`.
12. At most one summary request is in flight per session.
13. With `enabled: false`, zero summary requests, zero `ctx.compact()` calls, zero status writes.
14. With `compactWhenReady: false`, zero `ctx.compact()` calls.

## 9. Observability

FROZEN strings.

| State | `ctx.ui.setStatus("precompute", ...)` |
| --- | --- |
| `running` | `"precompute: summarizing..."` |
| `ready` | `"precompute: summary ready"` |
| `compacting` | `"precompute: compacting..."` |
| `failed` | `"precompute: summary failed"` |
| `idle` | `undefined` |

Command `/precompute`:

- No argument: reports one paragraph with state, `tokens`, gate, ceiling, `keepEntryId` (first 8 characters), tail tokens, and `failures`, through `ctx.ui.notify`.
- `force`: when idle and a plan exists, starts a summary even below the gate. Does nothing otherwise.
- Command handlers return void in pi, so the command reports through `ui.notify` and writes no status.

## 10. Test contract

### 10.1 Unit: boundary

Fixtures: empty branch, one user message, one complete turn, five turns, branch after a compaction, branch ending with a compaction entry, a single turn larger than the budget, a budget larger than the history.

Assertions: invariant 2, invariant 3, invariant 1. Oracle is `prepareCompaction` from the installed package, loaded through `import.meta.resolve("@earendil-works/pi-coding-agent")` and `dist/core/compaction/compaction.js`. The test fails if a pi upgrade changes the cut rules.

### 10.2 Unit: state

One table per rule in section 5 and each row in the section 4.3 table. Plus: gate boundary at `tokens = gate - 1` and `tokens = gate`; ceiling below `minCeilingTokens`; no-growth guard; retry guard on the same `keepEntryId`; `drop` on a stale tail; invariants 4 through 8, 13, 14.

### 10.3 Integration: one real session

A mock provider extension registers `pi.registerProvider({ streamSimple })`. It scripts an assistant turn that calls a test-only `bloat` tool returning large output, and a summary reply. The test opens `createAgentSession({ sessionManager: SessionManager.inMemory(), resourceLoader })` over a temp `agentDir` containing both extensions.

Script: prompt until the gate is crossed, then wait for `agent_settled` and the summary.

Assertions:

1. Exactly one summary request, and its response arrives before `compaction_start`.
2. `compaction_start` fires after the last user turn and before any further prompt.
3. The appended compaction entry has `fromHook: true` and `firstKeptEntryId === plan.keepEntryId`.
4. The next prompt's first request contains the summary message followed by the kept tail.
5. Invariant 12 holds, observed from the mock provider's request log.
6. With `compactWhenReady: false`, no compaction until the threshold, then `fromHook: true`.
7. With the extension disabled, `fromHook: false` and the summary request follows `compaction_start`.
8. A prompt queued while the summary is running is not aborted; compaction happens at the following `agent_settled`, and the new turn appears in the kept tail.
9. A turn large enough to push the tail past the limit makes the extension drop the summary and skip `ctx.compact()`.

If `complete()` does not route through the mock stream function, register the model under an `api` name the mock provider owns rather than changing the extension.

## 11. Frozen versus free

FROZEN: section 2 promises, section 3 field names and defaults, section 4 decision rules and order, section 5 states and transitions, section 6 exported signatures, section 8 invariants, section 9 strings, section 10 assertions.

FREE: file layout under the module, helper names, switch versus lookup table inside `judge`, test fixture construction, the exact wording of internal errors, whether `Limits` is a class or a record.

Anything frozen changes by bumping the version at the top and updating the tests that name it.
