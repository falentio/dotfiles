# Resuming a delegated subagent

Every call below runs inside a codemode script, since `codemode.mode: "only"` hides these tools from the top level. Call them as `tools.<name>(args)`.

`tools.mcp__t3_code__delegate_task` hands back two handles. They behave differently, and every resume decision follows from which one you reach for.

| Handle | Lifetime | Reach for it to |
|---|---|---|
| `taskId` | One run, terminal. `summary` freezes at completion. | Read the result with `tools.mcp__t3_code__task_status`; retry a lost response with the same `clientRequestId`. |
| `childThreadId` | The whole conversation, resumable. | Continue the work with `tools.mcp__t3_code__t3_thread_send`. |

**The child thread is the session.** Resuming means sending it another message; the new turn appends as `ordinal:2` to the same context, so the child still knows what it did.

## Decide

- **Continue the same work**, a follow-up, a correction, a next step that builds on what it did: `tools.mcp__t3_code__t3_thread_send` to `childThreadId`.
- **A fresh independent round**, a re-review, a re-run, a brief that must not inherit the old reasoning: a new `tools.mcp__t3_code__delegate_task` with a new `clientRequestId`.
- **Retry a lost `delegate_task` response**: repeat the call with the same `clientRequestId`. It returns the identical `taskId` and ignores a changed prompt; it is an idempotency key, not a resume.

## Resume

The call resolves to a JSON **string**, so parse it before reading the handles:

```js
const handle = JSON.parse(
  await tools.mcp__t3_code__delegate_task({
    task: "...", title: "...", mode: "async", role: "general",
    clientRequestId: "round-1",                  // idempotent retry key
  }),
);
const { taskId, childThreadId } = handle;

await tools.mcp__t3_code__t3_thread_wait({
  threadId: childThreadId, timeoutMs: 90000,
});

await tools.mcp__t3_code__t3_thread_send({
  threadId: childThreadId,                       // same conversation, context intact
  message: "now also do X",
  mode: "auto",                                  // auto | queue | steer | restart
  clientRequestId: "followup-1",
});
```

`mode`: `auto` starts an idle thread, steers an active turn, or queues behind one not yet steerable; `queue` is a separate follow-up turn; `steer` injects into an in-flight turn; `restart` interrupts and restarts it.

## Gotchas

- **`task_status` follows later runs.** After a resume, `status` stays `completed` and `summary` holds the original result, but `latestTerminalRunId` and `latestTerminalSummary` advance to the newest run, and `hasPendingChildRuns` is `true` while a follow-up executes. Read the frozen result from `summary`, the newest from `latestTerminal*`.
- **Waiting on a specific run:** pass `runId` to `tools.mcp__t3_code__t3_thread_wait`. Without it you wait on the latest run at call time, so a resume that already started can slip past.
- **Finding `childThreadId` later:** it is in the parsed `delegate_task` result, or in `tools.mcp__t3_code__t3_thread_list` as the entry whose `parentThreadId` is your thread and whose `relationshipToParent` is `subagent`.
- **Stopping a task:** `tools.mcp__t3_code__task_cancel` takes the `taskId` and stops later child-thread runs too.
