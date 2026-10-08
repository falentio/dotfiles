# Global instructions

## Tools run through codemode

A tool pi does not declare is still callable from a codemode script as `tools.<name>(args)`, with underscores where the name has hyphens: `tools.bash({ command })`, `tools.mcp__t3_code__delegate_task({ task })`. With `codemode.mode: "only"`, only `codemode` and `todo` are declared, so reach every other tool this way.

## Todos

Todo multi-step work (3+ steps): `init` the list with `todo` first, then work it.

## Checks

TypeScript, lint, and format errors wait until implementation is done. While implementing, ignore them: a fix mid-change is re-broken by the next edit. Clear them in one delegated pass after.

1. Commit the implementation first, so the fixer's commits land on top and a bad fix reverts alone.
2. Delegate one `tools.mcp__t3_code__delegate_task` to clear the errors. Name the changed files as Unix globs (`app/**/*.ts`, not prose); the child edits only those. Give it the `fix-checks` skill.
3. Read the report: each rule as a commit sha, or a reason it stayed.

Every rule fix is its own commit: an imperative subject that reads on its own, with the rule id in a `Rule:` trailer for `git log --grep`. The `fix-checks` skill holds the child's steps.

## Long-running processes

A dev server, watcher, worker, or tunnel — anything outliving the command that starts it — runs as a tmux **DEV session** via `devproc`, one per worktree; its name, `DEV <repo> <branch> <port>`, is the registry.

Every dev server binds the tailnet: pass `--host {host}` and `devproc` fills in the Tailscale address when Tailscale is up, else `0.0.0.0`. Never hand-write `--host 0.0.0.0`.

Read [tmux-processes.md](/home/kevin/.pi/agent/docs/tmux-processes.md) before starting, reading, stopping, or cleaning up one.

## Dev server handoff

Work that touches a frontend page, with a dev server up, ends its reply with a **Dev server** section, so the change is one click from being seen:

- **The server.** Its session name (`devproc here`) and URL, `http://<host>:<port>` from `devproc host` and the session's port.
- **Try it.** The route to open and the clicks or input that show the change.

## Lookups

Context7 owns library documentation; TinyFish owns everything else, a library's changelog included. A named library's API surface, configuration, and code examples go to the `find-docs` skill. Release notes, migration announcements, news, papers, and general facts go to the `tinyfish-search-fetch` skill.

When the answer is in a library's code, read the source, not `node_modules` or a build artifact: delegate a shallow clone to `~/source`, naming only the registry, library, and version (`npm zod@4.0.7`). The `library-source` skill holds the resolve and clone steps.

## Subagents

A lookup that needs one query runs here. Anything wider — several queries, or sources you must read and reconcile — runs in a `tools.mcp__t3_code__delegate_task` subagent: this context keeps the answer, the child thread keeps the search ceremony.

`delegate_task` **creates a T3 thread** and returns two handles: `taskId` for one run, frozen at its terminal state (read with `task_status`, cancel with `task_cancel`), and `childThreadId` for the thread itself, a full T3 thread the thread ops act on (`t3_thread_wait`, `t3_thread_send`, `t3_thread_interrupt`).

Read [delegated-subagents.md](/home/kevin/.pi/agent/docs/delegated-subagents.md) for the call shapes, the status fields, and the gotchas.
