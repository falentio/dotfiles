# Global instructions

## Tools run through codemode

A tool pi does not declare is still callable from a codemode script as `tools.<name>(args)`: `tools.bash({ command })`, `tools.read({ path })`, `tools.mcp__t3_code__delegate_task({ task })`. The name uses underscores where the tool's name has hyphens. With `codemode.mode: "only"`, only `codemode` and `todo` are declared, so reach every other tool this way.

## Todos

Todo multi-step work (3+ steps): `init` the list with `todo` first, then work it.

## Long-running processes

A dev server, watcher, worker, or tunnel — anything outliving the command that starts it — runs as a tmux **DEV session** via `devproc`, one per worktree. Its name, `DEV <repo> <branch> <port>`, is the registry: `tmux ls` alone tells you what runs, where, and on which port.

Read [tmux-processes.md](/home/kevin/.pi/agent/docs/tmux-processes.md) before starting, reading, stopping, or cleaning up one.

## Lookups

Context7 owns library documentation; TinyFish owns everything else, a library's changelog included. A named library's API surface, configuration, and code examples go to the `find-docs` skill. Release notes, migration announcements, news, papers, and general facts go to the `tinyfish-search-fetch` skill.

## Research runs in a subagent

A lookup that needs one query runs here. Anything wider, such as several queries or sources you must read and reconcile, runs in a `tools.mcp__t3_code__delegate_task` subagent: this context keeps the answer, the child thread keeps the search ceremony. Follow up by messaging that child thread, which still knows what it found.

## Delegated subagents

Call `tools.mcp__t3_code__delegate_task` through a codemode script. It returns two handles. `taskId` covers one run and freezes at its terminal state. `childThreadId` is the child's whole conversation and stays resumable.

Reach for an op by intent:

- **Start.** `delegate_task` with `mode: "async"` returns while the child runs; `mode: "wait"` blocks for the result.
- **Wait.** `tools.mcp__t3_code__t3_thread_wait` on `childThreadId` with `timeoutMs`. A timeout returns `timedOut: true` and stops nothing, so call again.
- **Resume.** `tools.mcp__t3_code__t3_thread_send` to `childThreadId` appends a turn with the child's context intact.
- **Retry a lost call.** Repeat `delegate_task` with the same `clientRequestId`. It returns the identical `taskId` and ignores a changed prompt.
- **Cancel.** `tools.mcp__t3_code__task_cancel` takes `taskId`, returns `cancel_requested`, and stops later child runs too.
- **Interrupt one run.** `tools.mcp__t3_code__t3_thread_interrupt` takes `childThreadId`.

Read [delegated-subagents.md](/home/kevin/.pi/agent/docs/delegated-subagents.md) for the call shapes, the status fields, and the gotchas.
