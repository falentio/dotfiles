# Spec: close the pi@1 gaps in the todos extension

Apply proposals 1-3 from the investigation at `.pi/agent/todos-port/`. Target:
`.pi/agent/extensions/todos/`. Work in `/home/kevin/Repositories/dotfiles` on
branch `feat/todos-pi1-extension` (already checked out).

## The bug

The extension's durable record is `details.phases` on the `todo` toolResult,
and `persistence.ts` rebuilds state by scanning the branch for a message with
`toolName === "todo"`. pi@1.0.4 puts `direct` tools in the codemode callable
set (`agent-session.js:1139-1142`), and this repo enables `+codemode`, so the
model calls `todo` from a codemode script. The only session record is then the
outer `codemode` result, which carries no phases. On resume the list is empty.
Reproduced: seed via codemode, resume, `todo view` returns "Todo list is empty."

## Change 1: exposure `model-only` (index.ts)

Add `exposure: "model-only"` to the `defineTool({...})` call. A `model-only`
tool is declared to the model (so the model still calls it directly) but is
excluded from the codemode callable set. Proven: a codemode script calling a
`model-only` tool gets "does not exist"; the model calling it directly works.
`model-only` stays in `pi.getActiveTools()`, so the existing
`setActiveTools` guard in `session_start` still finds it.

## Change 2: durable snapshot entry (index.ts + persistence.ts)

Defense in depth: write the state as a custom entry from `execute`, and teach
the reader to read it. This survives any future wrapper, not just codemode.

In `persistence.ts`:
- Add `export const TODO_SNAPSHOT_CUSTOM_TYPE = "todo_snapshot"`. This is what
  the tool writes now.
- Keep `USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit"` (do not delete it): old
  sessions from `@gamaraan/todos-tool` wrote it, and the reader still replays
  them. In the reader, treat either type as a snapshot: a small
  `SNAPSHOT_CUSTOM_TYPES` set of both strings, and match with `.has(...)`.
- Keep the message-toolResult branch as a fallback for sessions written before
  this change and for any direct call whose custom entry is missing.

In `index.ts`, in `execute`, after a successful non-read-only op, write the
snapshot: `pi.appendEntry(TODO_SNAPSHOT_CUSTOM_TYPE, { phases: outcome.phases })`.
`appendEntry` from `execute` lands on the branch before the toolResult (proven
by probe), so the reader's backward scan finds the newest snapshot first.

Ordering note: the reader scans newest-first and takes the first valid record.
Both writers (the custom entry and the toolResult) carry the same phases, so
order between them does not matter; the newest of either wins.

## Change 3: reminder on the actionable boundary (index.ts + tracker.ts)

pi@1 added `agent_before_settle`, the documented actionable boundary: a handler
can append a `custom_message` and `return { continue: true }` for one more model
request. Proven by probe: it fires with `outcome: "completed"`, the message
lands with `role: "custom"` + `customType`, and the turn continues.

Move the completion reminder from `agent_settled` to `agent_before_settle`:
- The handler calls `tracker.checkCompletion(...)`. Change `checkCompletion`
  so that instead of `await host.sendReminder(ctx, text)`, it returns the
  reminder text (or null), and the handler returns
  `{ entries: [{ type: "custom_message", customType: TODO_REMINDER_CUSTOM_TYPE, content: text, display: false }], continue: true }`.
- Guard against loops: `checkCompletion` already tracks `#reminderCount` and
  `#reminderAwaitingProgress`; keep those guards. The continuation must fire
  only when a reminder is actually produced, never unconditionally.
- Keep the `agent_end` handler that records `lastAssistant`; `agent_before_settle`
  runs after it.
- Drop the `agent_settled` reminder handler if it becomes empty. Keep any
  cleanup that genuinely belongs there.

The `context` pruning in `index.ts` already drops superseded `todo-reminder`
and `mid-run-todo-nudge` custom messages, so the boundary-injected reminder is
pruned from later turns the same way. Keep `TODO_REMINDER_CUSTOM_TYPE` in the
prune set.

## Tests

- `test/persistence.test.ts`: a `todo_snapshot` custom entry is read; a legacy
  `todo` toolResult is still read; newest-wins across both kinds.
- `test/tracker.test.ts`: `checkCompletion` returns the reminder text and
  honors the count/awaiting-progress guards (adapt existing cases).
- `test/smoke.test.ts`: assert the tool registers with `exposure: "model-only"`;
  assert a successful mutation calls `pi.appendEntry` with the snapshot type;
  assert `agent_before_settle` returns `{ entries: [...], continue: true }` when
  a reminder is due and `undefined` otherwise.

## Verify

1. `cd .pi/agent/extensions/todos && bun test` all pass.
2. `cd .pi/agent/extensions/todos && tsc --noEmit` clean.
3. `node .pi/agent/todos-port/verify.mjs` still 12/12.

## Rules

- Faithful to the existing code style: no `any`, no suppressions, comments only
  for a non-obvious why.
- Do not add `outputSchema`/`annotations`/`namespace` (declined in the
  investigation).
- Do not install anything.
- Do not commit; leave the tree for review.
