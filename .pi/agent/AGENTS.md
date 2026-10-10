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

Every dev server binds the wildcard: pass `--host {host}` and `devproc` fills in `0.0.0.0`, so the server listens on every interface — loopback, LAN, and tailnet — whether or not Tailscale is up. Never hand-write the host.

Read [tmux-processes.md](docs/tmux-processes.md) before starting, reading, stopping, or cleaning up one.

## Dev server handoff

Work that touches a frontend page, with a dev server up, ends its reply with a **Dev server** section, so the change is one click from being seen and proven:

- **The server.** Its session name (`devproc here`) and URL, `http://<host>:<port>` from `devproc host` and the session's port.
- **Try it.** The route to open and the clicks or input that show the change.
- **The evidence.** Screenshots of the change, reported per [Evidence](#evidence).

## Evidence

Every frontend change is proven with a screenshot of the change, embedded as `![<flow> <state>](<path>)` so the reader sees it. Name the flow and the state in the alt (`![picker guest-challenge]`, `![checkout empty-cart]`), so several shots read apart. One capture per image, each embedded on its own: a before/after pair, or shots of several pages, stay separate embeds at their captured paths — never stitched into one image, so every shot reads as the real surface. Scroll and zoom until the changed component sits whole inside the viewport; when one shot cannot hold it, take shots until every part is shown. Capture it through the `control-ui` skill.

## Lookups

Context7 owns library documentation; TinyFish owns everything else, a library's changelog included. A named library's API surface, configuration, and code examples go to the `find-docs` skill. Release notes, migration announcements, news, papers, and general facts go to the `tinyfish-search-fetch` skill.

Read library code from the clone, not a dependency's build artifact. `node_modules`, `target`, `.venv`, `vendor`, `__pycache__`, `~/.cargo/registry`, and `~/.m2` hold a dependency's transformed, deduped, or minified copy — the wrong surface, often stale, and a context hog. Crawl through the scout, which spawns the cloner; the source lands at `~/.pi/source` (see Subagents).

Our own project's build output is fair game — `dist/` from our library, `.nuxt/`, `.next/`, `.output/` from our frontend. That is our code, and generated types or bundles are sometimes the only place a fact is observable.

## Subagents

A lookup that needs one query runs here. Anything wider — several queries, or sources you must read and reconcile — runs in a `tools.mcp__t3_code__delegate_task` subagent: this context keeps the answer, the child thread keeps the search ceremony.

**Delegating spawns a subagent** — an agent of this thread, scoped to the one task in its prompt. `delegate_task` returns two handles: `taskId` for that run, frozen at its terminal state (read with `task_status`, cancel with `task_cancel`), and `childThreadId` for the child's session, a full T3 thread the thread ops act on (`t3_thread_wait`, `t3_thread_send`, `t3_thread_interrupt`).

**Work leaves this context as a subagent.** `tools.mcp__t3_code__create_threads` and `tools.mcp__t3_code__t3_thread_launch` open ordinary top-level conversations — peers of this chat, and the user's call: open one when the user asks for a separate, new, or top-level thread, and name it in your reply.

An async child notifies this thread when it reaches a terminal state — steered into an active turn, queued otherwise — so the default is to **end the turn** and let that notification arrive; read the result with `task_status` when you need it mid-turn. Reach for `t3_thread_wait` only when the result is needed before the turn can continue: `childThreadId` plus a `timeoutMs`, re-called while the reply is `timedOut: true`. `timeoutMs` bounds one wait call; it never estimates the child, so a `sleep`, a `task_status` poll loop, and a long timeout picked to outlast a guess stay banned.

Crawl the codebase through a scout, never in this context:

```text
A: main agent [1]
└── spawn S: scout  ← delegate_task; A never crawls; S must use codebase-scout skills [1a]
    ├── S spawns C: cloner  ← "use the library-source skill, do npm zod@4.0.7" [1a1]
    │   └── C: check ~/.pi/source → clone if absent → return path, repo, ref, sha [1a1a]
    └── S crawls  ← reads what C returned [1a2]
```

Ask the scout for findings, not the crawl: the answer, findings anchored to `path:line` with a status, gaps with a probe, and the cloner's source when fetched. No file dumps, no narration.

Reuse a scout's `childThreadId` across the subagents that follow — implementer, researcher, reviewer — so they ask it instead of re-reading. Fork the scout once per receiver with `t3_thread_fork` and hand each its own `targetThreadId`, so every subagent has a dedicated crawler. Arena, swarm, and any fan-out fork N times, one per worker. The `codebase-scout` skill holds the steps and the reply shape.

Read [delegated-subagents.md](docs/delegated-subagents.md) for the call shapes, the status fields, and the gotchas.
