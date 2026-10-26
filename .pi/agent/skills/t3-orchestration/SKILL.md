---
name: t3-orchestration
description: "Drive another agent in T3 Code: delegate a child task, continue it, steer it, interrupt it, and choose child task versus top-level thread. Use when spawning or resuming a subagent in T3, when a delegated task hangs or went silent, or when work needs its own checkout."
---

# T3 orchestration

The `t3-code` MCP hands work to other agents. Two containers, and picking the wrong one is the failure this skill prevents:

- **A child task** — `delegate_task`. Child work owned by *this* thread: a `taskId`, a terminal notification, a frozen `summary`.
- **A top-level thread** — `t3_thread_launch`, `create_threads`. A peer conversation the human sees. `parentThreadId: null`, so `task_status` cannot see it and its completion wakes nothing.

The user's word decides the container. "Subagent", "delegate", "fan out", "in parallel" → `delegate_task`. "New thread", "separate conversation", "its own worktree" → a launch.

Every rule here traces to a live probe; the log is at the end under [Evidence](#evidence). Reproduce one before doubting a rule.

## The two handles

`delegate_task` returns two ids that outlive each other differently.

| Handle | Scope | Reaches |
|---|---|---|
| `taskId` | One run, then frozen | `task_status`, `task_cancel`. `summary` stops moving at the first terminal state. |
| `childThreadId` | The whole conversation, resumable | `t3_thread_send`, `_read`, `_wait`, `_interrupt`. |

**Continue the work** → `t3_thread_send` to `childThreadId`; context intact, and the send creates a *new* `taskId`. **A fresh independent round** → a new `delegate_task` with a new `clientRequestId`. `childThreadId` is backing storage, never the address for a new round.

## Start

```js
const { content } = await tools.mcp__t3_code__delegate_task({
  task: "…self-contained brief…",
  title: "short display title",
  role: "implementation",
  mode: "async",
  clientRequestId: "round-1",
});
const { taskId, childThreadId } = JSON.parse(content[0].text);
```

Every tool here returns JSON text inside `content[0].text`. Parse it. A **failure is content too**, with `code` and `message`; only a transport or schema error throws.

Omitted `target` inherits this thread's provider, model, and options — the default, and right unless the user named a model or the task needs another provider. `role` is one-line framing (`implementation`, `research`, `review`, `design`, `test`, `general`); a persona travels as a skill the child reads.

## Run it

**`mode: "async"` already notifies this thread when the child finishes.** The terminal state posts a message into this conversation carrying the child's title and its `summary`, so the next step needs no `await`: launch, do other work, and handle the result when the notification arrives. A fire-and-forget batch is several async calls in one message, then work on something else.

The boundary: a notification lands **between** turns. It cannot cut into the middle of one, so work in flight finishes first, then the notification is delivered. Reproduced twice — a 12-second tool call outlasted a 4-second child, and the notification arrived after the call, not during it; and the same child alone, with the turn ended and no polling, still delivered.

That makes the choice mechanical:

- **Next step doesn't need the child's output** → `async`, keep working, end the turn when you run out. Do not poll, sleep, or spawn a watcher; each races a delivery already on its way.
- **The same turn cannot proceed without the result** → `mode: "wait"` with `timeoutMs`. It returns on completion, on a blocking question, or on a pending approval. On `waitTimedOut` the child still runs: re-wait, never re-delegate.

Read the result with `task_status` once the notification lands.

| Need | Move |
|---|---|
| The result blocks this turn | `mode: "wait"`; on `waitTimedOut`, the child still runs — re-wait, never re-delegate. |
| A resumed run to finish first | `t3_thread_wait` with `childThreadId`; re-call while `timedOut: true`. |
| The child asked a question | `hasPendingQuestion` → `t3_pending_request_list` → `_read` → `_respond`. |
| The child is stuck on an approval | `pendingApproval` names it; only its own approval holder can grant it. Report it. |
| The work is wrong and still running | `t3_thread_send` with `mode: "steer"`. |
| The work should stop | `task_cancel` (whole task) or `t3_thread_interrupt` (one run). |

## Isolation

`isolation: "worktree"` checks out **the parent's current local commit**, runs project setup, and starts the child there. Uncommitted edits are not copied — reproduced: a parent with 80 dirty paths handed down a clean tree at the same commit, on its own branch, at `/home/kevin/.t3/worktrees/<repo>/t3-<hash>`. Commit before delegating when the child must see work in progress. Omitted, the child shares this checkout and its edits land in the same tree.

## Tell the human

Link a thread as `[title](t3-thread://v1/<threadId>)` with the exact `threadId`, unencoded.

## Failure modes

- **Re-delegating instead of resuming or retrying.** The same `clientRequestId` returns the original task unchanged, original brief included — an idempotency key, not a resume.
- **Reading `status` as the last run.** It stays at the task's first terminal state. Newest run: `latestTerminalStatus` / `latestTerminalSummary`.
- **A model without its provider.** A model id is namespaced to a provider instance: `{model}` alone resolves against the *inherited* provider and fails `model_unavailable`. Send `providerInstanceId` too, and read both back from the result.
- **Building steps on remembered state.** `store()` did not survive between codemode invocations in testing. Keep ids in the conversation or a file.

## delegate_task inputs

| Field | Takes | Verified behaviour |
|---|---|---|
| `task` | 1–120,000 chars, trimmed | The child's whole prompt. Parent conversation is not copied. |
| `title` | ≤ 512 chars | Display title. Appears in the notification: `Delegated task <taskId> (<title>): <summary>`. |
| `role` | `implementation` \| `research` \| `review` \| `design` \| `test` \| `general` | One-line framing. Cannot load a persona. |
| `target` | `{providerInstanceId?, driverKind?, model?, options?}` | Omitted, the child inherits this thread's provider, model, and options. |
| `isolation` | `"shared"` (default) \| `"worktree"` | See Isolation. |
| `mode` | `"async"` (default) \| `"wait"` | `wait` blocks up to `timeoutMs` (default 10 min). |
| `timeoutMs` | number | Bounds **one** `wait` call. Never cancels the child. |
| `clientRequestId` | ≤ 256 chars | Idempotency key. Same value returns the identical task. |
| `runtimeMode` | `"inherit"` \| a mode the target advertises | Omit. See below. |
| `interactionMode` | `"inherit"` \| provider mode | Omit unless the user asks. |

### Writing the brief

The child starts with the `task` string and nothing else. A brief that assumes the parent's conversation produces a child that guesses. Carry four things: **the goal** (the artifact or answer), **the scope** (paths, globs, modules — name files, a child reads what it is pointed at), **the method** (how to verify: commands, the check to pass, the surface to drive), and **the report shape** (`summary` is the child's final message, so the shape is the contract).

Point at files; do not inline them. When the child needs codebase knowledge, point it at `repo_scout`: one call per repo, cached per child, so a follow-up reuses the session.

### target

Read `orchestrator_capabilities` for the live catalog: `providers[].providerInstanceId`, `models[]`, their `options` descriptors, and `runtimeModes`. It also returns `inheritedProviderInstanceId`, `inheritedModel`, and `inheritedOptions` — what an omitted `target` will do.

Reproduced failure shapes:

- Disabled provider → `provider_unavailable`: "Provider codex cannot run a child task: Provider instance is disabled." Check `canRunChildTask`, not just that the provider is listed.
- `{model: "<id>"}` with no `providerInstanceId` → `model_unavailable`: "Model claude-opus-5 is not advertised by provider pi." The id resolves against the **inherited** provider.
- An option the model does not advertise → `invalid_request`: "Model 9Router/deepseek on provider pi rejected options: Unknown option notARealOption; supported options: none."

Options are advertised per model, not per provider: Claude models carry `effort` and sometimes `fastMode`; a Pi model here carried none. `options` takes a record (`{effort: "max"}`) or an array. `[]` or `{}` clears inherited options; individual entries override. Read `providerInstanceId`, `model`, and `options` back from the result — that is the child's actual configuration, not what was asked for.

`runtimeMode` defaults to inherit, and the default is right. A narrower mode is **not** a read-only switch: on most providers `approval-required` and `auto-accept-edits` pause the child at each action needing approval, and this thread cannot approve. To bound what a child does, say so in the brief. A mode broader than this thread's is rejected; a narrower one is accepted (reproduced: a `full-access` parent delegating `auto-accept-edits` succeeded).

### Reading the result

```js
const s = JSON.parse((await tools.mcp__t3_code__task_status({ taskId })).content[0].text);
```

| Field | Means |
|---|---|
| `status` | `queued` \| `running` \| `waiting` \| `completed` \| `failed` \| `cancelled` \| `interrupted`. Frozen at the first terminal state; a resume does not move it. |
| `workState` | `working` \| `waiting_for_children` \| `result_available`. Separates a busy child from a finished turn that still has nested work. |
| `summary` | The frozen final result. Provider errors land here on failure. |
| `latestTerminalStatus`, `latestTerminalSummary`, `latestTerminalRunId` | The newest run after a resume. Null when it exactly repeats `summary`. |
| `hasPendingChildRuns` | Later queued or executing turns in the child thread. `task_cancel` stops those too. |
| `hasPendingQuestion`, `pendingApproval` | A blocking question, and the oldest pending approval. |
| `waitTimedOut` | True only on the `mode:"wait"` call whose budget elapsed. Later reads return false. |

A cancelled task returns its existing status when cancelled again; cancellation is idempotent. `task_cancel` returned `cancel_requested`, and the run had already settled as `interrupted` on the next read.

## Driving a running thread

```js
const r = JSON.parse((await tools.mcp__t3_code__t3_thread_send({
  threadId, message, mode: "auto", clientRequestId: "followup-1",
})).content[0].text);
// { threadId, messageId, runId, taskId?, status, delivery }
```

`delivery` is the fact to read; `mode` is only the request. Reproduced:

| `mode` | Thread state | `delivery` | What happened |
|---|---|---|---|
| `auto` | idle | `started` | New run, `status: "starting"`. |
| `auto` | run in flight | `queued` | Waited behind the running turn. |
| `queue` | idle | `started` | **Ran immediately.** An idle thread has nothing to queue behind. |
| `queue` | run in flight | `queued` | Appeared in `t3_queue_list`. |
| `steer` | run in flight | `steered` | Injected into that turn. `runId` was the **running** run, not a new one; the child answered the steer and abandoned the original instruction. |
| `restart` | run in flight | `restarted` | Interrupts, then starts a new run. |

`steer` is how to redirect live work. The steer text becomes a second user message inside the running turn, so a child that already finished the old instruction only reads it if it is still working.

A send to a **completed** child creates a new task whose id is derived from the send: `node:delegated-task:<scope>:thread-send:<clientRequestId>`. That follow-up's completion notifies this thread as `Delegated task <that id> (<child title>): <summary>`, separate from the original. Keep both ids straight: the original's `summary` holds the original result.

### Wait

```js
await tools.mcp__t3_code__t3_thread_wait({ threadId, runId, timeoutMs: 60000 });
// { threadId, runId, status, timedOut }
```

- Without `runId`: waits on the **latest run at call time**, so a resume that starts during the wait slips past. Pass the `runId` from the send result to pin one run.
- `timedOut: true` stops nothing. Re-call while it is true; it bounds one call, never estimates the child.
- `status: "idle"` with `runId: null` means the thread has no run to wait on.
- Waiting reports status only. It does not acknowledge a delegated result; `task_status` does.

### The queue

Messages queued behind a running turn are runs, addressable by `queuedRunId`.

| Tool | Takes | Notes |
|---|---|---|
| `t3_queue_list` | `{threadId?, cursor?, limit?}` | Returns `{items: [{queuedRunId, text, truncated}], nextCursor}`. |
| `t3_queue_read` | `{threadId?, queuedRunId}` | Up to 16,000 chars. |
| `t3_queue_edit` | `{threadId?, queuedRunId, text}` | Replaces text, keeps attachments. Rejects runs no longer queued. |
| `t3_queue_cancel` | `{threadId?, queuedRunId}` | Drops that message. |
| `t3_queue_reorder` | `{threadId?, queuedRunId, beforeRunId}` | `beforeRunId: null` moves it to the end. |
| `t3_queue_promote_to_steer` | `{threadId?, queuedRunId, targetRunId}` | Delivers it as steering into the named active run. |

Every mutation returns `{sequence}`, not the queue. Re-read `t3_queue_list` after one.

**Interrupt does not drop the queue.** Reproduced: interrupting run 4 left the queued run 5, which was then promoted and ran to completion. To drop queued work, cancel it with `t3_queue_cancel`.

### Interrupt

```js
await tools.mcp__t3_code__t3_thread_interrupt({ threadId, runId?, reason? });
// { threadId, runId, status: "interrupt_requested" | "no_active_run" | <terminal> }
```

Without `runId` it targets the newest interruptible run. The run settles as `interrupted` — reproduced within the next read, though the promise is "a moment later", so read the run list rather than assuming. `no_active_run` on an idle thread is not an error; nothing was running.

### Read

```js
await tools.mcp__t3_code__t3_thread_read({
  threadId, view: "messages", afterPosition, limit: 20, maxCharsPerItem: 4000,
});
```

Returns `{thread, recentRuns, items, nextPosition, hasMore}`.

- `view: "messages"` — user and assistant messages plus proposed plans. `view: "activity"` — every summarised timeline item, including tool calls.
- `thread` carries what a parent needs: `status`, `activeRunId`, `latestRunId`, `branch`, `worktreePath`, `parentThreadId`, `relationshipToParent` (`subagent` \| `fork` \| null), `creationSource`, `runCount`, `itemCount`, `pendingRequestCount`, `pullRequests`.
- Long items truncate. Recover with `{itemId, textOffset: nextTextOffset}` until `nextTextOffset` is null.
- Paginate with `afterPosition: nextPosition`.

### Finding a child again

Lose `childThreadId` and recover it from `t3_thread_list`: the entry whose `parentThreadId` is this thread and whose `relationshipToParent` is `subagent`. To find it by content instead, `t3_thread_search` over one project, bounded and not exhaustive.

### Other thread operations

| Tool | What it does |
|---|---|
| `t3_thread_configure` | Set a thread's provider, model, options. Does not change permission modes. |
| `t3_thread_configuration` | Read a thread's selection and modes. |
| `t3_thread_organize` | `pin`, `unpin`, `snooze` (needs `snoozedUntil`), `unsnooze`, `settle`, `unsettle`, `archive`, `unarchive`, `mark_unread`. Settling *this* thread takes effect when the turn ends, returning `settlesWhenTurnEnds: true`; a failed or interrupted turn, or a queued message, leaves it active. |
| `t3_thread_fork` | Fork from `{type:"latest_stable"}`, `{type:"run", runId}`, or `{type:"checkpoint", checkpointId}`. Omit `threadId` to fork this thread. |
| `t3_thread_merge_back` | Merge context from a thread into a related one in the same project. |
| `t3_thread_transfers` | Read context-transfer status. |

### Questions and approvals

```js
t3_pending_request_list({ threadId })            // { requestIds }
t3_pending_request_read({ threadId, requestId }) // { requestId, questions: [...] }
t3_pending_request_respond({ threadId, requestId, answers })
```

Answers are questions only. `t3_pending_request_respond` cannot approve a permission request; that decision stays with the child's own approval holder. Re-read the request before responding — the record can outlive its provider callback.

## Failure codes

Failures arrive as content, `{_tag: "OrchestratorMcpFailure", code, message}`.

| Code | Means | Move |
|---|---|---|
| `task_not_found` | The id does not belong to this thread. | Recover the id from `t3_thread_list`; do not retry. |
| `provider_unavailable` | The provider cannot run a child task (disabled). | Pick one with `canRunChildTask: true`. |
| `model_unavailable` | The model is not advertised by the resolved provider. | Re-read `orchestrator_capabilities`; send `providerInstanceId` with `model`. |
| `invalid_request` | A field or option the provider rejects. | Read the message; it names the accepted set. |
| `orchestration_error` | The command did not dispatch. | Re-read the thread's run list before retrying, so a command that landed is not run twice. |

`clientRequestId` makes the mutation idempotent: the same value returns the original result and ignores a changed payload. Use one stable id per intended action, reused across retries of that action, and a **new** id for a genuinely new action.

## Evidence

Probe date 2026-10-20, app `t3code 0.1.1-nightly.20261020.3411`. Parent: provider `pi`, model `9Router/deepseek`, `runtimeMode: full-access`. Source read: `apps/server/dist/binCli-Bm8tVhP8.mjs` in the app bundle.

```text
E1  delegate_task async -> {taskId, childThreadId, status:"running", workState:"working", summary:null}
    PROVED: async does not block; summary is null while running.
E2  A message arrived in the parent turn: "Delegated task <taskId> (<title>) [completed]: PROBE-OK"
    PROVED: a terminal state notifies the parent; no polling needed.
E2a Notification lands BETWEEN turns, not inside one. Child started async and told to reply in one turn;
    a 12s bash call outlasted its ~4s run. The notification arrived only after the call returned
    (child runs: ["1 completed"], last message "MIDTURN-OK").
    PROVED: an async notification cannot interrupt in-flight work; work finishes, then delivery.
E2b Notification survives an ended turn with no polling. Child started async, the script returned
    immediately, unrelated work ran, nothing called task_status or t3_thread_wait.
    Delivery still arrived: "Delegated task <taskId> (idle delivery probe) [completed]: IDLE-DELIVERY-OK".
    PROVED: fire-and-forget works; polling would only race a delivery already on its way.
E3  task_status terminal -> {status:"completed", workState:"result_available", summary:"PROBE-OK",
    latestTerminalStatus:"completed", latestTerminalSummary:null}
    PROVED: summary holds the result; latestTerminalSummary is null when it equals summary.
E4  task_status {taskId:"node:delegated-task:nope"} -> {code:"task_not_found",
    message:"Delegated task ... does not belong to thread <parent>."}
    PROVED: failures return as content, not a throw.
E5  Repeated delegate_task, SAME clientRequestId, different task body, title and role
    -> identical taskId and childThreadId, status:"completed", summary:"PROBE-OK" (the original).
    PROVED: an idempotency key, not a resume; the new brief is ignored.
E6  mode=wait, timeoutMs 8000, child took 3.5s -> elapsed 3495ms, status:"completed", waitTimedOut:false.
E7  mode=wait, timeoutMs 5000, child running sleep 25 -> elapsed 5044ms, {status:"running", waitTimedOut:true}.
    t3_thread_wait 5000 -> {status:"running", timedOut:true}; re-wait 30000 -> {status:"completed", timedOut:false};
    task_status summary:"SLOW-OK".
    PROVED: waitTimedOut bounds one call only; the child keeps running; re-wait until timedOut:false.
E8  t3_thread_send to childThreadId -> {delivery:"started", status:"starting", taskId:"...:thread-send:<id>",
    runId:"...ordinal:2"}; its completion notified as a separate message. Original task_status after:
    {status:"completed", summary:"PROBE-OK", latestTerminalStatus:"completed", latestTerminalSummary:"FOLLOWUP-OK",
    latestTerminalRunId:"...ordinal:2"}. Child runs: ["ordinal 2 completed","ordinal 1 completed"].
    PROVED: send keeps context; status stays at the first terminal state; latestTerminal* advance.
E9  mode auto idle -> delivery "started";  mode queue idle -> delivery "started" (same as auto);
    mode auto busy -> delivery "queued";  mode queue busy -> "queued" and appears in t3_queue_list;
    mode steer busy -> delivery "steered", runId was the RUNNING run, the child answered the steer text.
    PROVED: delivery, not mode, is the fact.
E10 interrupt on a running turn -> {status:"interrupt_requested"}; runs after:
    ["5 running","4 interrupted","3 completed","2 completed","1 completed"]; t3_queue_list -> {"items":[]}.
    The queued run 5 had been promoted to running and completed.
    PROVED: interrupt does not drop the queue; t3_queue_cancel is how queued work is dropped.
E11 task_cancel on a just-started long task -> {status:"cancel_requested"}; next task_status -> "interrupted".
    PROVED: cancel is fast and idempotent; re-cancel returns the existing status.
E12 Parent dotfiles HEAD 9e58662d with 80 dirty paths; isolation:"worktree" child reported
    pwd -> /home/kevin/.t3/worktrees/dotfiles/t3-ec591416, branch chore/check-git-status,
    git status --porcelain -> clean, git log -1 -> 9e58662d.
    PROVED: worktree copies the commit, not uncommitted edits, and gets its own branch.
E13 disabled provider -> {code:"provider_unavailable", "Provider codex cannot run a child task: ... disabled."}
    unadvertised option -> {code:"invalid_request", "... rejected options: Unknown option notARealOption;
      supported options: none."}
    model without provider -> {code:"model_unavailable", "Model claude-opus-5 is not advertised by provider pi."}
    PROVED: a model id is namespaced to a provider instance.
E14 runtimeMode "auto-accept-edits" from a full-access parent -> status:"running". A narrower mode is accepted.
E15 create_threads -> {threadId:"thread:mcp:...", createdBy:"agent", creationSource:"mcp"}; thread detail
    {parentThreadId:null, relationshipToParent:null, branch:"main", worktreePath:null}.
    PROVED: a top-level thread; task_status cannot see it and its completion wakes nothing.
E16 t3_thread_launch with a worktree -> {threadId, projectId, modelSelection, runId, status:"preparing"}.
    PROVED: "preparing" on accept; workspace preparation precedes the agent turn.
E17 orchestrator_capabilities features: {appOwnedSubagents:true, asyncPolling:true, cancellation:true,
    batchThreadCreation:true, threadManagement:true, incrementalThreadRead:true, scheduledTasks:true,
    maxBatchThreads:20}. pi: 5 models, canRunChildTask true. codex/claudeAgent/cursor/grok/antigravity/muse:
    canRunChildTask false, constraints ["Provider instance is disabled."]
E18 codemode store() in one invocation, load() in the next -> undefined.
    PROVED: keep taskIds in the conversation or a file, never in store().
```
