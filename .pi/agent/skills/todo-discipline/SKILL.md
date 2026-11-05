---
name: todo-discipline
description: >
  Execution discipline for the `todo` tool: plan before working and mark each
  task done as it lands. Use when a request has 3+ distinct steps, when the
  user provides a plan or checklist, or when new work arrives mid-task.
---

# Todo discipline

A visible plan keeps a long request honest. Two rules: plan before working, mark progress as it lands.

## Plan before working

A request with 3+ distinct steps, a plan the user wrote, or N enumerated items gets a list first.

1. Call `todo` with one `init` in the same step as your first read or grep, so the call rides real work.
2. Phases are short noun phrases covering the whole request, investigation through verification.
3. One task per item, 5-10 words, the user's wording where it is already that short. Every item gets a task.

Done when the list names every step the request needs, and a later turn could execute each task without re-planning.

## Mark done as it lands

A task is done when its outcome exists and was confirmed: the change applied and the check ran, the question answered with evidence, the bug reproduced then fixed. Mark it in the same step that proves it.

- Ending a turn: write `<!-- todo: done "exact task text" -->` in the reply. No tool call.
- Mid-turn: `done` in the same step as the next action.
- A phase lands whole: `done` with `phase` alone.

The list is what the user reads to see where the work stands, so a task that landed but stayed open misreports the session.

## Revise, don't restart

`update` renames, moves, and reorders. `init` replaces the plan and its progress record. New work arriving mid-task is `append`. A cancelled task is `drop`. A task waiting on someone else is `block` with a reason; `unblock` when it can move again.
