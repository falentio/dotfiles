---
name: t3-orchestration-evidence
description: "Probe log behind the t3-orchestration skill rules: one dated reproduction per claim. Read only when a rule needs doubting or restating."
---

# t3-orchestration evidence

Each rule in [./SKILL.md](./SKILL.md) rests on a probe below. Reproduce one before doubting a rule.

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

## Probe round 2 — every example re-run (2026-10-30)

Server `0.1.4-nightly.20261027.3770`. Parent: provider `pi`, model `9Router/deepseek`, `runtimeMode: full-access`. Method: each code block in SKILL.md run live, return shapes copied.

```text
R1  delegate_task {mode:"wait", timeoutMs:180000, role:"general"} -> 3.6s, parsed keys:
    taskId, childThreadId, link, childRunId, childNodeId, status, workState, hasPendingChildRuns,
    latestTerminalRunId/Status/Summary/ResultContextTransferId, providerInstanceId, model, options,
    summary, resultContextTransferId, hasPendingQuestion, pendingApproval, waitTimedOut.
    content[0].text and structuredContent hold the same object.
    PROVED: the JSON.parse(content[0].text) example is right; results carry link.
R2  task_status {taskId} -> completed, workState result_available, summary PROBE-OK,
    latestTerminalSummary null, waitTimedOut false. Same key set as R1.
    PROVED: the task_status example parses correctly; latestTerminal* is null when equal to summary.
R3  t3_thread_send to the finished child, mode auto -> delivery "started", status "starting",
    taskId node:delegated-task:<scope>:thread-send:<clientRequestId>, runId ...ordinal:2.
    Its completion notified separately. PROVED: send keeps context; delivery is the fact.
R4  t3_thread_wait {threadId, runId, timeoutMs} -> {threadId, runId, status:"completed", timedOut:false}.
    PROVED: the wait example's shape is exact.
R5  t3_thread_read {view:"messages", limit, maxCharsPerItem} -> {thread, recentRuns, items,
    nextPosition, hasMore}; thread carries status, parentThreadId, relationshipToParent "subagent",
    link, branch, worktreePath; items carry position, itemId, text, textTruncated, nextTextOffset.
    PROVED: the read example's shape is exact.
R6  delegate_task mode wait timeoutMs 4000 on a sleep-90 child -> status running, workState working,
    summary null, waitTimedOut true; a later task_status reports waitTimedOut false.
    PROVED: a timeout bounds one call and cancels nothing.
R7  Repeated delegate_task, SAME clientRequestId, different brief/title/role -> the original
    taskId, status completed, summary PROBE-OK. PROVED: idempotency key, not a resume.
R8  t3_queue exists only as one action tool: list, read, edit, cancel, reorder, promote_to_steer.
    list -> {items:[{queuedRunId, text, truncated}], nextCursor}. Mutations -> {sequence}.
    A mode:"queue" send's runId IS the queuedRunId.
    read on a run no longer queued -> invalid_request "The queued message was not found."
    reorder with beforeRunId null -> invalid_request "This action needs `beforeRunId`."
    reorder {queuedRunId: B, beforeRunId: A} -> {sequence}, list order became B, A.
    promote_to_steer {queuedRunId, targetRunId} -> {sequence}; the steered text reached the target
    run, which answered it, and the queued run ended cancelled.
    PROVED: six separately named queue tools do not exist; reorder needs a live beforeRunId.
R9  t3_pending_request exists only as one action tool: list, read, respond.
    Child blocked inside mcp__t3-code__request_secret (activity item "secret_request/waiting",
    tool call still running): task_status hasPendingQuestion false, pendingApproval null,
    t3_pending_request list -> {requestIds: []}.
    PROVED: a secret request or an approval is not a pending question; it waits on the human.
R10 t3_thread_configure with no modelSelection -> {threadId, modelSelection:{instanceId, model},
    runtimeMode, interactionMode}. t3_thread_transfer action "status" -> {transfers:[...]}.
    t3_thread_organize action "pin" -> {sequence}.
    PROVED: no t3_thread_configuration, t3_thread_fork, t3_thread_merge_back, or t3_thread_transfers.
R11 t3_thread_interrupt {runId} on an already-ended run -> status "completed", not an error.
    No runId on a running turn -> "interrupt_requested", and the queued run behind it ran to completion.
    PROVED: interrupt leaves the queue alone.
R12 task_cancel -> {status:"cancel_requested"}. PROVED: cancel is idempotent.
```
