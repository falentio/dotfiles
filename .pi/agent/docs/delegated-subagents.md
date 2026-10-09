# Delegated subagents

Every call below runs inside a codemode script, since `codemode.mode: "only"` hides these tools from the top level. Call them as `tools.<name>(args)`. Each tool returns a JSON **string**, so parse it before reading a field.

`tools.mcp__t3_code__delegate_task` hands back two handles. They behave differently, and every lifecycle decision follows from which one you reach for.

| Handle | Lifetime | Reach for it to |
|---|---|---|
| `taskId` | One run, terminal. `summary` freezes at completion. | Read the result with `tools.mcp__t3_code__task_status`; cancel with `tools.mcp__t3_code__task_cancel`; retry a lost response with the same `clientRequestId`. |
| `childThreadId` | The whole conversation, resumable. | Continue the work with `tools.mcp__t3_code__t3_thread_send`; wait or interrupt a run with `tools.mcp__t3_code__t3_thread_wait` and `tools.mcp__t3_code__t3_thread_interrupt`. |

**The child thread is the session.** Resuming means sending it another message; the new turn appends as `ordinal:2` to the same context, so the child still knows what it did.

## Decide

- **Continue the same work**, a follow-up, a correction, a next step that builds on what it did: `tools.mcp__t3_code__t3_thread_send` to `childThreadId`.
- **A fresh independent round**, a re-review, a re-run, a brief that must not inherit the old reasoning: a new `tools.mcp__t3_code__delegate_task` with a new `clientRequestId`.
- **Retry a lost `delegate_task` response**: repeat the call with the same `clientRequestId`. It returns the identical `taskId` and ignores a changed prompt; it is an idempotency key, not a resume.

## Start

`mode: "async"` returns a handle while the child runs. `mode: "wait"` blocks for the result and sets `waitTimedOut: true` if the wait budget runs out; the child keeps running either way.

```js
const handle = JSON.parse(
  await tools.mcp__t3_code__delegate_task({
    task: "...", title: "...", mode: "async", role: "general",
    clientRequestId: "round-1",                  // idempotent retry key
  }),
);
const { taskId, childThreadId } = handle;
```

`role` frames the child in one line. It does not load a persona; a persona travels as a skill the child reads.

## Wait

Pass `childThreadId` and a `timeoutMs`. A timeout returns `timedOut: true` and stops nothing, so call again to keep waiting. Without `runId` you wait on the latest run at call time, so a resume that already started can slip past; pass the `runId` from the send result to wait on a specific run.

```js
const w = await tools.mcp__t3_code__t3_thread_wait({ threadId: childThreadId, timeoutMs: 90000 });
// { status: "running", timedOut: true }  -> call again
// { status: "completed", timedOut: false } -> read task_status
```

## Resume

Send a message to `childThreadId`. The new turn keeps the child's context.

```js
await tools.mcp__t3_code__t3_thread_send({
  threadId: childThreadId,                       // same conversation, context intact
  message: "now also do X",
  mode: "auto",                                  // auto | queue | steer | restart
  clientRequestId: "followup-1",
});
```

`mode` picks how the message lands:

- `auto` starts an idle thread, steers an active turn, or queues behind one not yet steerable.
- `queue` is a separate follow-up turn. The send result is `status: "queued"`, and `task_status` shows `hasPendingChildRuns: true` while it waits.
- `steer` injects into an in-flight turn. The send result is `delivery: "steered"`.
- `restart` interrupts and restarts the active turn. On server `0.0.46-nightly.20261007.2761` this returns `orchestration_error` with `Failed to dispatch orchestration command message.dispatch`, on a running turn, in 4 of 4 attempts. Use `steer` to redirect a live turn, or `t3_thread_interrupt` then `queue`.

A queued turn is a normal run. Manage it with `tools.mcp__t3_code__t3_queue_list`, `t3_queue_read`, `t3_queue_edit`, `t3_queue_reorder`, `t3_queue_promote_to_steer`, and `t3_queue_cancel`. Each edit, reorder, promote, and cancel returns a `sequence` number, not the queue. `t3_thread_interrupt` drops the whole queue.

## Cancel and interrupt

`tools.mcp__t3_code__task_cancel` takes `taskId` and returns `status: "cancel_requested"`, not a terminal state. It stops later child-thread runs too. `tools.mcp__t3_code__t3_thread_interrupt` takes `childThreadId` and stops one run, returning `status: "interrupt_requested"`. Both settle the run as `interrupted` a moment later; poll `task_status` or `t3_thread_wait` to see it. Cancelling an already-terminal task returns its existing status.

## Read status

`tools.mcp__t3_code__task_status` takes `taskId`. An unknown id throws `task_not_found` scoped to your thread.

```js
{
  status: "completed",              // running | completed | interrupted | failed | cancelled
  workState: "result_available",    // working | waiting_for_children | result_available
  summary: "...",                   // frozen at the first terminal state
  hasPendingChildRuns: false,
  latestTerminalStatus: "completed",
  latestTerminalSummary: "...",     // advances on each resume
}
```

`workState` separates a working child from one that finished its turn but still has queued work. `hasPendingChildRuns` is `true` while a queued follow-up runs.

## Gotchas

- **`task_status` follows later runs.** After a resume, `status` stays `interrupted` and `summary` holds the original result, but `latestTerminalRunId` and `latestTerminalSummary` advance to the newest run. Read the frozen result from `summary`, the newest from `latestTerminal*`. A child's own status stays at its first terminal state, so do not read `status` as "the last run's status".
- **Waiting on a specific run:** pass `runId` to `tools.mcp__t3_code__t3_thread_wait`. Without it you wait on the latest run at call time, so a resume that already started can slip past.
- **Finding `childThreadId` later:** it is in the parsed `delegate_task` result, or in `tools.mcp__t3_code__t3_thread_list` as the entry whose `parentThreadId` is your thread and whose `relationshipToParent` is `subagent`.
- **Never estimate a wait.** Wait only through `t3_thread_wait`, re-called while `timedOut: true`; otherwise end the turn and let the terminal-state notification wake this thread. `sleep`, a `task_status` poll loop, and a `timeoutMs` chosen to outlast a guess are all banned — `timeoutMs` bounds one wait call, it never estimates the child.
- **A terminal state wakes this thread.** A delegated task that reaches a terminal state posts a notification back, steered into an active turn or queued otherwise. End the turn instead of polling, and read the result with `task_status` when you need it mid-turn.
