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

## After a PR

Opening a PR starts a review gate, and the gate is mandatory: a second agent reviews the PR, a third fixes every finding, and a fourth babysits it green. The author does not review its own PR.

Each prompt may be worded freely; it must carry the instructions below, so the child does the same job every time.

1. **Review.** Spawn one `tools.mcp__t3_code__delegate_task` to review the PR. Its prompt must name the PR number, name `/skill:code-review` and `/skill:poteto-mode` as skills to read, and ask for the findings, each with evidence, written to a markdown file under `/tmp`. A working prompt:

   ```text
   review pr #<n> using /skill:code-review /skill:poteto-mode write down evidence to /tmp with format markdown
   ```

2. **Fix.** When the review's terminal notification arrives, spawn a second `tools.mcp__t3_code__delegate_task` to fix every finding, handing it the review's `/tmp` file as the worklist. Its prompt must name that file, name `/skill:poteto-mode`, and ask for every finding fixed. A working prompt:

   ```text
   fix all findings in <path> using /skill:poteto-mode
   ```

3. **Babysit.** When the fix's terminal notification arrives, spawn a third `tools.mcp__t3_code__delegate_task` to babysit the PR until it is green. Its prompt must name the PR number and `/skill:poteto-mode`, whose **Babysit** playbook (`playbooks/babysit.md`) drives the PR to merge-ready in `drive` mode. A working prompt:

   ```text
   babysit pr #<n> until green using /skill:poteto-mode
   ```

Naming `/skill:poteto-mode` in each prompt is what loads the persona: it travels as a skill the child reads, never as the `role` line.

## Long-running processes

A dev server, watcher, worker, or tunnel — anything outliving the command that starts it — runs as a tmux **DEV session** via `devproc`, one per worktree; its name, `DEV <repo> <branch> <port>`, is the registry.

Every dev server binds the wildcard: pass `--host {host}` and `devproc` fills in `0.0.0.0`, so the server listens on every interface — loopback, LAN, and tailnet — whether or not Tailscale is up. Never hand-write the host.

Read [tmux-processes.md](docs/tmux-processes.md) before starting, reading, stopping, or cleaning up one.

## Dev server handoff

Work that touches a frontend page, with a dev server up, ends its reply with a **Dev server** section, so the change is one click from being seen and proven:

- **The server.** Its session name (`devproc here`) and URL, `http://<host>:<port>` from `devproc host` and the session's port.
- **Try it.** The route to open and the clicks or input that show the change.
- **The evidence.** Screenshots of the change, reported per [Evidence](#evidence).

## File references

A repo or project file you name in a reply is written as a path from the repo root, prefixed `./`: `./src/index.ts`, never the bare `index.ts`. A bare filename is ambiguous the moment two files share it, and it does not resolve from the repo or travel with the branch. This holds wherever a path appears, in prose and in evidence alike.

## Evidence

Report every evidence path per [File references](#file-references): relative to the repo root, prefixed `./` (`![picker guest-challenge](./.audit/proof/picker.png)`, `./.audit/proof/run.log`). A capture the tool saved outside the workspace is copied in first.

Every frontend change is proven with a screenshot of the change, embedded as `![<flow> <state>](<path>)` so the reader sees it. Name the flow and the state in the alt (`![picker guest-challenge]`, `![checkout empty-cart]`), so several shots read apart. One capture per image, each embedded on its own at its own `./` path: a before/after pair, or shots of several pages, stay separate embeds — never stitched into one image, so every shot reads as the real surface. Scroll and zoom until the changed component sits whole inside the viewport; when one shot cannot hold it, take shots until every part is shown. Capture it through the `control-ui` skill.

## Lookups

Context7 owns library documentation; TinyFish owns everything else, a library's changelog included. A named library's API surface, configuration, and code examples go to the `context7` MCP server. Release notes, migration announcements, news, papers, and general facts go to the `tinyfish-search-fetch` skill.

Read library code from the clone, not a dependency's build artifact. `node_modules`, `target`, `.venv`, `vendor`, `__pycache__`, `~/.cargo/registry`, and `~/.m2` hold a dependency's transformed, deduped, or minified copy — the wrong surface, often stale, and a context hog. Crawl through the scout, which spawns the cloner; the source lands at `~/.pi/source` (see Subagents).

Our own project's build output is fair game — `dist/` from our library, `.nuxt/`, `.next/`, `.output/` from our frontend. That is our code, and generated types or bundles are sometimes the only place a fact is observable.

## Subagents

A lookup that needs one query runs here. Anything wider — several queries, or sources you must read and reconcile — runs in a `tools.mcp__t3_code__delegate_task` subagent: this context keeps the answer, the child thread keeps the search ceremony.

**Delegating spawns a subagent** — an agent of this thread, scoped to the one task in its prompt. Its two handles, the delivery modes, and the result fields live in the **t3-orchestration** skill; read it before a call you have not made before.

**Work leaves this context as a subagent.** A top-level thread — `create_threads`, `t3_thread_launch` — is a peer of this chat and the user's call: open one when the user asks for a separate, new, or top-level thread, and name it in your reply.

An async child notifies this thread when it finishes, so the default is to **end the turn** and let that notification arrive. Reach for `t3_thread_wait` only when the result is needed before the turn can continue, re-called while the reply is `timedOut: true` — never a `sleep` or a poll loop.

Crawl a codebase with **`repo_scout`**, never in this context:

```text
A: main agent [1]
└── repo_scout(repo, question)  ← one cached session per repo [1a]
    └── answer: findings at path:line, gaps with probes [1a1]
```

One session per repo, one question at a time, evicted after ten idle minutes and reopened from disk, so a follow-up reuses the prompt cache instead of re-crawling. A dependency's repo comes from **`package_repo`** (`{ package, registry }`); its source is already at `~/.pi/source` when `library-source` ran, and that path can be passed as `repo`. The **codebase-scout** skill holds the report shape and the rules.

Delegation is for work, not for reading: several queries, or sources you must read and reconcile.
