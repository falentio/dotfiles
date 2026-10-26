---
name: codebase-scout
description: "Read and search a codebase through a cached scout session, not in the main context. Use when you need to understand code, grep across many files, or answer where things live, and when several questions hit the same repo."
---

# Codebase scout

Never crawl the codebase in the main context. A crawl is file reads and grep output; it crowds the window and buries the answer. Ask a **scout** and reuse it.

Read the right surface. A dependency's code comes from the clone the `library-source` skill places at `~/.pi/source`, never from `node_modules`, `target`, `vendor`, or the cargo registry — those are transformed, deduped, or minified. Our own project's build output is fair game: `dist/`, `.nuxt/`, `.next/`, `.output/` are our code, and generated types or bundles are sometimes the only place a fact is observable.

## One call, one session

`repo_scout` is the scout. It keeps one agent session per repo and answers by reading a checkout of it, so a follow-up question continues the same conversation and reuses the prompt cache instead of re-crawling.

```js
const report = await tools.repo_scout({
  repo: "https://github.com/colinhacks/zod",
  question: "How does it validate a date-time string, and where?",
});

// Follow-up: same repo, same session, no re-crawl.
const again = await tools.repo_scout({ repo: "github.com/colinhacks/zod", question: "Which error does it throw?" });
```

`repo` takes a git URL, `host/owner/name`, `owner/name`, or a local path. Every spelling of one repo lands on one session: a worktree, the main clone, and the https URL share it when the checkout has an `origin`.

Do not spawn a subagent to crawl code. One `repo_scout` call replaces `delegate_task` plus `t3_thread_fork`, keeps the crawl out of this context, and comes back in the report shape below.

## Which repo

- **A dependency** — get its repo from the package: `await tools.package_repo({ package: "zod", source: "npm", version: "4.0.7" })`. Pass the `clone` line's url and ref to `repo_scout`. `confidence: stated` is the package's own manifest; `guess` is a name search, and it is never the `clone` target.
- **The version matters** — `version` names the release; the returned `ref` is a git tag git confirmed, so `repo_scout({ repo, ref })` reads the code that shipped. No `ref` means no tag matched, and the default branch is what you get.
- **A dependency whose source must sit at `~/.pi/source`** — run `library-source` first, then pass that path as `repo`. A local path is given a thin `--shared` clone, so it is read as it stands without edits shifting under the scout.
- **This project** — pass the repo root or the git URL. The scout reads a scratch checkout, never the branch you are editing.

## The session

| Behaviour | Value |
|---|---|
| Sessions per repo | one, keyed by canonical identity |
| Concurrency | one question at a time; later questions queue in order |
| Idle eviction | 1 hour after a question settles; the next question reopens the same conversation |
| `ref` | a tag, branch, or commit; it is part of the session key, so `repo@v1.2.3` is its own conversation |
| Tools the scout has | `read`, `grep`, `find`, `ls` — read-only, no bash, no edit |
| Model | the caller's model; `model: "provider/id"` overrides it |

The reply ends with `repo`, `path`, `sha`, `thread` (the session file), and `turn`. `turn opened` means the first question of a new conversation; `turn continued` means the cache was reused.

Ask two repos as two calls. Ask one repo twice as two calls with the same `repo` — they run in order and stay in one conversation.

## What the scout returns

**A report, not a crawl.** Every line spends the budget the call exists to save.

```text
answer      ← direct, no preamble, one or two sentences
findings    ← ≤ 30, each: id, one falsifiable claim, path:line, status
gaps        ← ≤ 10: what stayed open, why, and the probe that would settle it
blockers    ← ≤ 5, each with who resolves it
source      ← the checkout, commit, and session file that answered
```

| Field | Holds | Must not hold |
|---|---|---|
| answer | the finding | narration, restated task |
| claim | one assertion | several claims, hedging |
| anchor | `path:line` | file contents, grep output, listings, diffs |
| status | `VERIFIED` \| `INFERRED` \| `STALE` \| `UNVERIFIED` | prose justification |
| gaps | missing item + probe | silence, invented claims |

**Hard limits.** ≤ 800 words, ≤ 120 lines. Pointers only. A pointer may quote one line, and only when that line is the finding.

A claim with no anchor is `UNVERIFIED`; a claim with no probe is a gap, not a finding. A finding the scout could not produce goes under gaps — never omitted, never invented. Empty gaps or blockers says `none`; it does not drop the heading.

Run the probe a gap names yourself, in this context, or give it to the next call as the question.

## Example

```text
answer
zod validates a date-time string by building a format schema around a compiled ISO regex.

findings
F1  _isoDateTime() builds the schema with format "datetime".   packages/zod/src/v4/core/api.ts:454   VERIFIED
F2  datetime() compiles the regex the check runs.              packages/zod/src/v4/core/regexes.ts:104 VERIFIED
F3  Parsing dispatches to the v4 core, not legacy v3.          packages/zod/src/index.ts:1            INFERRED

gaps
what   whether an invalid value throws or returns a result object
why    the error path sits outside the crawled area
probe  grep -rn 'ZodError' packages/zod/src/v4/core/errors.ts

blockers
none

source
repo   github.com/colinhacks/zod
path   ~/.pi/scout/repos/github.com-colinhacks-zod
sha    34b400a5422b
thread ~/.pi/scout/sessions/...jsonl
turn   opened
```

Note the shape. `answer` answers in one sentence. Findings carry `path:line` and a status. The one open question sits under `gaps` with a probe. `blockers` says `none`. `source` names the checkout, commit, and session, so a later call or a reviewer reads the same code without re-cloning.

## The session file

The report's `thread` is the conversation, on disk. That is where a crawl lives: it is how you audit what the scout saw, and how a resumed `repo_scout` continues instead of rereading. Do not hand-edit it.
