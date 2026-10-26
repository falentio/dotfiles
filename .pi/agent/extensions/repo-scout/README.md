# repo-scout

Two tools that replace the scout-subagent dance with one call.

| Tool | Takes | Returns |
|---|---|---|
| `repo_scout` | a repo (URL, `host/owner/name`, `owner/name`, or a local path) and a question | the scout report: `answer`, findings anchored to `path:line`, gaps, blockers, and the checkout/commit that answered |
| `package_repo` | a package name and a registry (`npm`, `jsr`) | the git repo URLs that serve it, each with provenance and confidence |

Both are `codemode` tools, so they are reached from codemode scripts:

```js
const repo = await tools.package_repo({ package: "zod" });
const report = await tools.repo_scout({ repo: "https://github.com/colinhacks/zod", question: "How does it validate a date-time?" });
```

## One session per repo

A repo gets **one** `AgentSession`, keyed by its canonical identity (`github.com/owner/name`,
lowercased, `.git`/query/fragment stripped; a local checkout is keyed by its `origin`, so a worktree,
the main clone, and the https URL all share one session).

That session is the point. Every later question about the same repo appends to the same conversation,
so the provider's prompt cache is reused instead of re-crawling from zero, and the report comes back
with `turn continued` instead of `turn opened`.

- **One question at a time.** Further questions queue in a FIFO behind the running one; nothing is
  rejected. Different repos run in parallel.
- **Ten idle minutes, then evicted.** The clock restarts when a question settles, so a long crawl is
  never evicted mid-run. Eviction disposes the session.
- **Eviction does not lose the cache.** The conversation is persisted, so the next question reopens
  that file and continues the same history. A new conversation is only started the first time.

## What the scout is

- **The caller's model.** `ctx.model` with the caller's `ModelRegistry`, so it authenticates exactly
  as the asking thread does. `model: "provider/id"` overrides it; `thinkingLevel` defaults to medium.
- **Read-only.** `read`, `grep`, `find`, `ls`. No bash, no edit, no write.
- **Only the scout skills.** The resource loader has extensions, themes, context files, and prompt
  templates switched off, so loading this extension inside its own scout cannot recurse.
- **A report, not a dump.** The first message carries the report contract from
  `skills/codebase-scout`: 800 words, pointers only, no file contents or grep output.

## The checkout it reads

Never your working tree: you edit it while a scout is mid-crawl, and a silently changed file makes its
next answer wrong. Instead:

- a **remote** repo is shallow-cloned once into `~/.pi/scout/repos/<slug>` and fetched again before a
  reopened session;
- a **local** path gets a `git clone --shared` (hardlinked objects, its own worktree and index).

Every report ends with `repo`, `path`, `sha`, `thread` (the session file), and `turn`.

## package_repo

Answers provenance, in order, stopping as soon as the manifest states a repository:

1. the manifest's own `repository`, `githubRepository`, then a `bugs`/`homepage` that is itself a repo
   root — `stated`;
2. the npm tarball, when nothing else is named — `kind: tarball`, provenance only, not browsable;
3. a GitHub name search — `guess`, and labelled as one.

`jsr` reads `https://jsr.io/@scope/name/meta.json`. Set `GITHUB_TOKEN` to raise the search rate limit.

## State and environment

| Path | Holds |
|---|---|
| `~/.pi/scout/repos/<slug>` | scratch checkouts |
| `~/.pi/scout/sessions/<file>.jsonl` | scout conversations, reopened after eviction |

| Variable | Effect |
|---|---|
| `PI_SCOUT_HOME` | moves both directories (tests set it) |
| `PI_SCOUT_IDLE_MS` | idle window, default `600000` |
| `GITHUB_TOKEN` / `GH_TOKEN` | authenticated GitHub search in `package_repo` |

## Files

| File | Role |
|---|---|
| `index.ts` | Wiring: registers both tools, one registry per calling context, disposes on shutdown. |
| `tools.ts` | Both tools as plain functions, plus paths, identity resolution, and the report header. |
| `scout-registry.ts` | Sessions: queue, idle clock, eviction, reopen. No pi imports. |
| `repo-id.ts` | Canonical repo identity from every accepted spelling. |
| `checkout.ts` | The scratch checkout: clone, refresh, origin, HEAD. |
| `registry.ts` | Package name to repo URLs. Pure parsers plus the two fetches. |
| `agent-session.ts` | The one place `createAgentSession` is called. |
| `DESIGN.md` | Why each of those choices was made. |

## Tests

```sh
cd ~/.pi/agent/extensions/repo-scout
npm test          # 51 tests: parsers, registry queue/eviction, checkouts, and a full pipeline run
npm run typecheck
```

The pipeline test runs a real `AgentSession` on a fake provider (`@earendil-works/pi-ai/providers/faux`),
so it proves open → continue → evict → reopen with no credentials and no network. `test/register.mjs`
resolves pi's package names for the test run, the way the extension loader does.

## Known limits

- **One repo per call.** Two repos are two calls (and two sessions); that is what keeps the cache whole.
- **Reports are text.** `package_repo`'s output is line-oriented, not structured content.
- **The registry lives in the pi process.** It is not shared between two pi processes; both would open
  the same session file and write to it. Use one process per repo at a time.
- **A self-hosted forge under a path prefix** (`https://host/git/owner/name`) is read as `host/git/owner`,
  because the repo path is taken as the first two segments.
