---
name: t3-orchestration
description: "Drive another agent in T3 Code: delegate a child task, continue it, steer it, interrupt it, and choose child task versus top-level thread. Use when spawning or resuming a subagent in T3, when a delegated task hangs or went silent, or when work needs its own checkout."
---

# T3 orchestration

Two containers, and picking the wrong one is the failure this skill prevents.

- **Child task** — `delegate_task`: work owned by *this* thread, with a `taskId`, a terminal notification, and a frozen `summary`.
- **Top-level thread** — `t3_thread_launch`, `create_threads`: a peer the human sees. `parentThreadId: null`, so `task_status` cannot see it and its completion wakes nothing.

The user's word decides. "Subagent", "delegate", "fan out", "in parallel" → `delegate_task`. "New thread", "separate conversation", "its own worktree" → a launch.

Every rule here traces to a live probe, logged in [./evidence.md](./evidence.md). Reproduce one before doubting a rule.

## Handles

| Handle | Scope | Reaches |
|---|---|---|
| `taskId` | one run, then frozen | `task_status`, `task_cancel`; `summary` stops at the first terminal state |
| `childThreadId` | the whole conversation | `t3_thread_send`, `_read`, `_wait`, `_interrupt` |

Continue the work → `t3_thread_send` to `childThreadId`: context intact, and the send creates a *new* `taskId`. A fresh independent round → a new `delegate_task` with a new `clientRequestId`. `childThreadId` is backing storage, never the address for a new round.

```js
const { content } = await tools.mcp__t3_code__delegate_task({
  task, title, role: "implementation", mode: "async", clientRequestId: "round-1",
});
const { taskId, childThreadId } = JSON.parse(content[0].text);
```

Every tool returns its JSON in `content[0].text`, mirrored as `structuredContent`. A **failure is content too** (`code`, `message`); only transport or schema errors throw.

Omitted `target` inherits this thread's provider, model, and options — the right default unless the user named a model or the task needs another provider. `role` is one-line framing (`implementation`, `research`, `review`, `design`, `test`, `general`); a persona travels as a skill the child reads.

## Run it

`mode: "async"` (the default) notifies this thread at the child's terminal state, carrying its title and `summary`. So launch, do unrelated work, and handle the result when it lands; a batch is several async calls, then other work.

A notification lands **between** turns, never inside one, so in-flight work finishes first (probed: a 12s call outlasted a 4s child).

- **Next step doesn't need the output** → `async`, keep working, end the turn. Never poll, sleep, or watch: each races a delivery already on its way.
- **This turn can't proceed without it** → `mode: "wait"` with `timeoutMs` (default 10 min), which returns on completion, a blocking question, or a pending approval. On `waitTimedOut` the child still runs: re-wait, never re-delegate.

| Need | Move |
|---|---|
| A resumed run to finish first | `t3_thread_wait` with `childThreadId`, re-called while `timedOut: true` |
| The child asked a question | `hasPendingQuestion` → `t3_pending_request` with `action` `list` → `read` → `respond` |
| The child is stuck on an approval | `pendingApproval` names it; only its own approval holder can grant it. Report it. |
| The work is wrong and still running | `t3_thread_send` with `mode: "steer"` |
| The work should stop | `task_cancel` (whole task) or `t3_thread_interrupt` (one run) |

The result, once the notification or wait lands:

```js
const s = JSON.parse((await tools.mcp__t3_code__task_status({ taskId })).content[0].text);
```

| `task_status` field | Means |
|---|---|
| `status` | `queued` \| `running` \| `waiting` \| `completed` \| `failed` \| `cancelled` \| `interrupted`. Frozen at the first terminal state; a resume does not move it. |
| `workState` | `working` \| `waiting_for_children` \| `result_available` — a busy child versus a finished turn still holding nested work. |
| `summary` | The frozen final result; provider errors land here on failure. |
| `latestTerminalStatus`, `latestTerminalSummary`, `latestTerminalRunId` | The newest run after a resume; null when it repeats `summary`. |
| `hasPendingChildRuns` | Later queued or executing turns in the child thread; `task_cancel` stops those too. |
| `hasPendingQuestion`, `pendingApproval` | A blocking question, and the oldest pending approval. |
| `waitTimedOut` | True only on the `mode:"wait"` call whose budget elapsed; later reads return false. |

Cancellation is idempotent: `task_cancel` returns `cancel_requested`, a re-cancel returns the existing status, and the run settles as `interrupted`.

## Isolation

`isolation: "worktree"` checks out **the parent's current local commit** at `/home/kevin/.t3/worktrees/<repo>/t3-<hash>` on its own branch, runs project setup, and starts the child there. Uncommitted edits are not copied (probed: 80 dirty paths handed down a clean tree), so commit before delegating when the child must see work in progress. Omitted, `"shared"` shares this checkout and the child's edits land in it.

## Inputs

| Field | Takes | Behaviour |
|---|---|---|
| `task` | 1–120,000 chars, trimmed | The child's whole prompt; the parent conversation is not copied. |
| `title` | ≤ 512 chars | Display title. The notification reads `Delegated task <taskId> (<title>) [<status>]: <summary>`. |
| `role` | see above | One-line framing; cannot load a persona. |
| `target` | `{providerInstanceId?, driverKind?, model?, options?}` | Omitted, the child inherits this thread's provider, model, and options. |
| `isolation` | `"shared"` (default) \| `"worktree"` | See Isolation. |
| `mode` | `"async"` (default) \| `"wait"` | `wait` blocks up to `timeoutMs`. |
| `timeoutMs` | number | Bounds **one** `wait` call; never cancels the child. |
| `clientRequestId` | ≤ 256 chars | Idempotency key: the same value returns the identical task, a changed payload ignored. |
| `runtimeMode` | `"inherit"` \| a mode the target advertises | Omit. See below. |
| `interactionMode` | `"inherit"` \| provider mode | Omit unless the user asks. |

### The brief

The child starts with `task` and nothing else. Carry four things: **goal** (the artifact or answer), **scope** (paths, globs, modules — name files, since a child reads what it is pointed at), **method** (how to verify: commands, the check to pass, the surface to drive), and **report shape** (`summary` is the child's final message, so the shape is the contract). Point at files; never inline them. For codebase knowledge point at `repo_scout`: one session per repo, reused by a follow-up.

### target

Read `orchestrator_capabilities` for the live catalog — `providers[].providerInstanceId`, `models[]`, `options` descriptors, `runtimeModes` — plus `inheritedProviderInstanceId`, `inheritedModel`, `inheritedOptions`, which is what an omitted `target` does.

A disabled provider, a `{model}` with no `providerInstanceId` (the id resolves against the **inherited** provider), or an unadvertised option fails as `provider_unavailable`, `model_unavailable`, `invalid_request` — see Failure modes. For the first, check `canRunChildTask`, not that the provider is listed.

Options are advertised per model, not per provider (Claude models carry `effort`, sometimes `fastMode`; a Pi model carried none). `options` takes a record (`{effort: "max"}`) or an array; `[]`/`{}` clears inherited ones, single entries override. Read `providerInstanceId`, `model`, and `options` back from the result — that is the child's real configuration, not what was asked for.

`runtimeMode` defaults to inherit, and the default is right. A narrower mode is **not** read-only: `approval-required` and `auto-accept-edits` pause the child at each action needing approval, and this thread cannot approve. Bound a child in the brief instead. Broader than this thread's is rejected; narrower is accepted.

## Driving a thread

```js
const r = JSON.parse((await tools.mcp__t3_code__t3_thread_send({
  threadId, message, mode: "auto", clientRequestId: "followup-1",
})).content[0].text);
// { threadId, messageId, runId, taskId?, status, delivery }
```

`delivery` is the fact; `mode` is only the request.

| `mode` | Thread | `delivery` | What happened |
|---|---|---|---|
| `auto` | idle | `started` | New run, `status: "starting"`. |
| `auto` | run in flight | `queued` | Waited behind the running turn. |
| `queue` | idle | `started` | **Ran immediately** — nothing to queue behind. |
| `queue` | run in flight | `queued` | Appeared in the `t3_queue` `list`, under the returned `runId`. |
| `steer` | run in flight | `steered` | Injected into that turn; `runId` was the **running** run, and the child answered the steer, abandoning the original instruction. |
| `restart` | run in flight | `restarted` | Interrupts, then starts a new run. |

`steer` is how to redirect live work: the text becomes a second user message inside the running turn, so a child that already finished the old instruction reads it only if it is still working.

A send to a **completed** child creates a new task, its id derived from the send (`node:delegated-task:<scope>:thread-send:<clientRequestId>`), and its completion notifies separately. The original's `summary` keeps the original result.

### wait

```js
await tools.mcp__t3_code__t3_thread_wait({ threadId, runId, timeoutMs: 60000 });
// { threadId, runId, status, timedOut }
```

Without `runId` it waits on the **latest run at call time**, so a resume starting during the wait slips past; pass the send's `runId` to pin one run. `timedOut: true` stops nothing — re-call while true; it bounds one call and never estimates the child. `status: "idle"` with `runId: null` means no run to wait on. Waiting reports status only; it does not acknowledge a delegated result, which `task_status` does.

### queue

Queued messages are runs, addressed by `queuedRunId` — which is exactly the `runId` a `mode: "queue"` send returned.

```js
t3_queue({ threadId, action: "list" })   // { items: [{queuedRunId, text, truncated}], nextCursor }
```

| `action` | Extra args | Does |
|---|---|---|
| `list` | `cursor?`, `limit?` | Send order, paged. |
| `read` | `queuedRunId` | Up to 16,000 chars. |
| `edit` | `queuedRunId`, `text` | Replaces the text, attachments stay. |
| `cancel` | `queuedRunId` | Drops that message. |
| `reorder` | `queuedRunId`, `beforeRunId` | Moves it before that **currently queued** run. `null` is rejected: `"This action needs beforeRunId."` |
| `promote_to_steer` | `queuedRunId`, `targetRunId` | Delivers it as steering into the named active run, and the queued run ends `cancelled`. |

Each takes an optional `threadId` (omitted: this thread) and returns `{sequence}`, not the queue, so re-read `list`. A message no longer queued fails `invalid_request`: `"The queued message was not found."` **Interrupt does not drop the queue**: an interrupt left a queued run that later completed; `cancel` is how queued work is dropped.

### interrupt

```js
await tools.mcp__t3_code__t3_thread_interrupt({ threadId, runId?, reason? });
// { threadId, runId, status: "interrupt_requested" | "no_active_run" | <terminal> }
```

Without `runId` it targets the newest interruptible run, which settles as `interrupted` a moment later — read the run list rather than assuming. `no_active_run` on an idle thread is not an error, and a run that already ended returns its terminal status (`completed`).

### read

```js
await tools.mcp__t3_code__t3_thread_read({
  threadId, view: "messages", afterPosition, limit: 20, maxCharsPerItem: 4000,
});
// { thread, recentRuns, items, nextPosition, hasMore }
```

`messages` gives user and assistant messages plus proposed plans; `activity` gives every summarised timeline item, tool calls included. `thread` carries `status`, `activeRunId`, `latestRunId`, `branch`, `worktreePath`, `parentThreadId`, `relationshipToParent` (`subagent` \| `fork` \| null), `creationSource`, `runCount`, `itemCount`, `pendingRequestCount`, `pullRequests`. Long items truncate: recover with `{itemId, textOffset: nextTextOffset}` until it is null. Paginate with `afterPosition: nextPosition`.

### Finding a child again

Recover a lost `childThreadId` from `t3_thread_list`: the entry whose `parentThreadId` is this thread and whose `relationshipToParent` is `subagent`. By content instead, `t3_thread_search`: one project, bounded, not exhaustive.

### Other thread operations

| Tool | Does |
|---|---|
| `t3_thread_configure` | Reads without `modelSelection`: `{modelSelection: {instanceId, model}, runtimeMode, interactionMode}`. With it, sets provider, model, options; permission modes stay. |
| `t3_thread_organize` | `action`: `pin`, `unpin`, `snooze` (needs `snoozedUntil`), `unsnooze`, `settle`, `unsettle`, `archive`, `unarchive`, `mark_unread`. Settling *this* thread applies at turn end; a failed turn or a queued message leaves it active. |
| `t3_thread_transfer` | `action`: `fork` from `sourcePoint` (`{type:"latest_stable"}`, `{type:"run", runId}`, `{type:"checkpoint", checkpointId}`), `merge_back` into `targetThreadId`, or `status`. Omit `threadId` for this thread. |

### Questions and approvals

```js
t3_pending_request({ threadId, action: "list" })               // { requestIds: [] }
t3_pending_request({ threadId, action: "read", requestId })    // { requestId, questions: [...] }
t3_pending_request({ threadId, action: "respond", requestId, answers })
```

Answers are questions only; `respond` cannot approve a permission request, which stays with the child's approval holder. Re-read before responding, since the record can outlive its provider callback. A child blocked on `request_secret`, or on an approval, keeps `hasPendingQuestion: false` and an empty `requestIds`: those wait for the human in the UI, not for you.

## Failure modes

Failures arrive as `{_tag: "OrchestratorMcpFailure", code, message}`.

| Symptom | Means | Move |
|---|---|---|
| `task_not_found` | The id is not this thread's. | Recover it from `t3_thread_list`; do not retry. |
| `provider_unavailable` | The provider cannot run a child task (disabled). | Pick one with `canRunChildTask: true`. |
| `model_unavailable` | Not advertised by the resolved provider. | Re-read `orchestrator_capabilities`; send `providerInstanceId` with `model`. |
| `invalid_request` | A field or option rejected. | Read the message; it names the accepted set. |
| `orchestration_error` | The command did not dispatch. | Re-read the run list before retrying, so a command that landed is not run twice. |
| Re-delegating instead of resuming | The same `clientRequestId` returns the original task, brief included: an idempotency key, not a resume. | `t3_thread_send` to `childThreadId`. |
| Reading `status` as the last run | It stays at the first terminal state. | `latestTerminalStatus` / `latestTerminalSummary`. |
| A model without its provider | `{model}` alone resolves against the inherited provider. | Send `providerInstanceId` too, and read both back. |
| Steps built on remembered state | `store()` did not survive between codemode invocations. | Keep ids in the conversation or a file. |

One stable `clientRequestId` per intended action, reused across retries of that action; a **new** id for a genuinely new action.

## Tell the human

Results already carry `link`, so paste it verbatim. Without one: `[title](t3-thread://v1/<threadId>)`, the exact `threadId`, unencoded.
