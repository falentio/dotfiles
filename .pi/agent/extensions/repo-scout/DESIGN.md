# repo-scout: design

Two pi tools replace the spawn/fork dance in the codebase-scout skill.

| Tool | Input | Output |
|---|---|---|
| `repo_scout` | `repo` (git URL, host/repo, or local path), `question` | the scout-style report |
| `package_repo` | `package`, `registry` | git repo URLs for that package: homepages + browsable code URLs, with provenance |

Both are `exposure: "codemode"`, so the model reaches them from codemode scripts like every other tool.

## Decisions

### 1. One owner per repo: a scratch checkout, not the live worktree

A scout session is a pi `AgentSession` with a `cwd`. The cache the user wants is the provider prompt
cache, and that only holds if the session's context (including its working tree) does not shift under
it. A live worktree does shift: the main agent edits it between questions, and a file a scout already
read changes on disk, so its next answer is stale without saying so.

So every repo gets its own **scratch checkout** under `~/.pi/scout/repos/<slug>`, cloned from the git
URL:

- `repo` given as a git URL or `host/owner/name` -> shallow clone into the scratch dir, reused across
  calls. `git fetch` + `reset --hard origin/HEAD` on checkout so a stale clone still answers.
- `repo` given as a local path -> a `git clone --shared` of it (cheap hardlink clone that still gives
  an independent worktree and index).

This keeps the "question goes to the remote codebase" story honest, and it is the only way to answer
for a repo the user does not have checked out (which the current t3 `delegate_task` cannot do).

### 2. One session per repo, keyed by the normalized repo identity

`normalizeRepo` maps every accepted spelling to one key: `github.com/owner/name` (lowercased, trailing
`/`, `.git`, query and fragment stripped, scp style `git@host:owner/name` accepted). Local paths
resolve to their `origin` URL when the repo has one, else to `realpath` — so a worktree, the main
checkout, and `https://github.com/o/n` all land on the same session when an origin exists.

Key = that identity. The registry holds at most one `ScoutSession` per key.

### 3. One concurrency per session, queued behind a fair FIFO

`ScoutSession.run()` pushes onto `queue`, sets `busy`, and awaits its turn. A `pump()` loop runs one
question at a time and resolves the next waiter when it settles. FIFO, no starvation, no rejection:
further requests wait, as asked. The registry does not block other repos — different repos run in
parallel (separate `AgentSession`s, separate checkouts).

### 4. 10 minutes of inactivity, measured from the end of a run

`lastUsedAt` is set when a question settles (not when it starts, so a long crawl is not evicted
mid-run). A sweeper ticks every 30 s and evicts sessions idle past `SCOUT_IDLE_MS` (default
600_000, env `PI_SCOUT_IDLE_MS`). Eviction aborts in-flight work (nothing should be in flight past an
idle window), disposes the session, and drops the registry entry.

Prompt cache survives eviction because the conversation is **persisted**: the session manager writes
into `~/.pi/scout/sessions/` (a directory of its own, so pi's session listing stays clean). On the next
question the registry reopens that file with `SessionManager.open`, and the request is an append to the
same conversation — same cache prefix as before eviction.

**pi names the file, not us.** `SessionManager.create` ignores a desired filename and generates
`<timestamp>_<uuid>.jsonl`, so the registry asks the conversation what it actually wrote and remembers
that path. Remembering a guessed path instead starts a second file after every eviction — which loses
exactly the cache eviction exists to preserve. `scout-registry.test.ts` pins this against an adapter
that reports a different path than the one it was offered.

A reopened conversation **replays** its history, so it already holds the opening contract and the
earlier crawl: the adapter sends the bare question, and the report says `turn continued`. Only a
brand-new conversation gets the opening message, and only that turn is labelled `opened`.

That is the whole reason to persist at all: without it, the 10-minute eviction would throw the cache
away every time someone pauses.

### 5. Model: the caller's current model, by default

`ctx.model` is the model the calling thread is running. The tool passes it to `createAgentSession`
together with `ctx.modelRegistry` as the `modelRuntime`, so the scout authenticates exactly as the
caller does, with no second credential path. An optional `model` parameter takes `provider/model` to
override; `thinkingLevel` (default `medium`) is optional too.

`updateModel` is not passed: a scout must not silently switch models, because a switch drops the
cache the whole design exists to keep.

### 6. The scout is a read-only agent

Tools: `read`, `grep`, `find`, `ls`. No bash, no edit, no write: a question is answered by reading.
`bash` would let a scout mutate its checkout and, worse, reach the network or the host.

Resources: only the scout skills are loaded (`codebase-scout`, `library-source`), through a
`DefaultResourceLoader` with `noExtensions`, `noThemes`, `noContextFiles`. Extension discovery is
off on purpose: loading this very extension inside its own scout session would recurse, and every
extension load costs startup time for nothing.

### 7. State the model needs is passed, not discovered

The agent loop the user is replacing forks the scout so it keeps the knowledge. Here the session
file keeps it, and the first message of a fresh session carries the checkout path and the report
contract (the exact `answer/findings/gaps/blockers/source` shape from `codebase-scout/SKILL.md`),
so one tool call yields a report the caller can read without asking again.

## The second tool: `package_repo`

`package_repo({ package, registry? })` resolves a package name to the git repos that serve it, so
`repo_scout` can be pointed at it. Order, each step skipped when the earlier one answered:

1. **manifest homepages** (`homepage`, `repository.url`, `bugs.url`) when the registry returns them;
2. **npm**: `https://registry.npmjs.org/<name>` -> the same manifest fields; `latest.dist.tarball` is
   the last resort, since a tarball is not browsable;
3. **GitHub search** (`https://api.github.com/search/repositories?q=<name>`): a best guess, clearly
   marked `confidence: "guess"`, because a name match is not provenance.

`registry` defaults to `npm`. `jsr` is supported through `https://jsr.io/<scope>/<name>/meta.json`
(its manifest carries `githubRepository`). An unknown registry is an error naming the supported ones.

Output is data: `{ package, registry, repos: [{ url, kind, source, confidence }], warnings }`.
`kind` is `repository` (browsable git) or `tarball` (provenance only). Callers pass `url` straight to
`repo_scout`.

## Boundaries

- Network boundaries live in `registry.ts` (`fetch`) and `checkout.ts` (`git`), nowhere else; the
  parsing is pure and unit-tested with fixtures.
- Session lifetime and queueing live in `registry.ts` only; nothing else touches `AgentSession`.
- Both tools are `codemode` exposure and declared read-only, idempotent, open-world.

## Out of scope

- Writing to the caller's worktree, or editing the repo under study.
- Multi-repo questions in one call. Two calls, one per repo, stay cached separately.
- Sharing one scout session across two different repos: that is what one session per repo forbids.
