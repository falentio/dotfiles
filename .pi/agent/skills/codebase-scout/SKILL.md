---
name: codebase-scout
description: "Read and search a codebase through a delegated scout thread, not in the main context. Use when you need to understand code, grep across many files, or answer where things live, and when several subagents need the same codebase knowledge."
---

# Codebase scout

Never crawl the codebase in the main context. A crawl is file reads and grep output; it crowds the window and buries the answer. Send a **scout** — a delegated thread that reads the codebase and reports — and reuse it.

## The flow

```text
A: main agent [1]
└── spawn S: scout  ← delegate_task; A never crawls [1a]
    ├── S spawns C: cloner  ← first move when source is needed [1a1]
    │   └── C checks out source  ← "use the library-source skill, do npm zod@v4.0.7" [1a1a]
    │       ├── path in ~/source? [1a1a1]
    │       │   ├── yes: reuse [1a1a1a]
    │       │   └── no: clone shallow [1a1a1b]
    │       └── return path, repo, ref, sha [1a1a2]
    └── S crawls the codebase  ← reads what C returned [1a2]
```

Spawn the cloner regardless of whether `~/source` looks populated — the cloner owns that check. One scout per area; record the returned `childThreadId`.

## Reuse the scout

A scout that has read the codebase knows more than a fresh subagent. Hand its id to the subagents that follow, each in its own fork:

```text
S: scout thread [1]
└── per receiver R  ← implementer, researcher, reviewer, worker [1a]
    ├── fork S → F  ← t3_thread_fork, sourcePoint latest_stable [1a1]
    ├── hand F.targetThreadId to R [1a2]
    └── R asks F  ← t3_thread_send; F keeps S's knowledge [1a3]
```

```js
const fork = JSON.parse(await tools.mcp__t3_code__t3_thread_fork({
  threadId: scoutThreadId,
  sourcePoint: { type: "latest_stable" },
  title: "scout for implementer",
}));
// hand fork.targetThreadId to the consumer
```

A fork inherits everything the scout learned and is independent: a receiver's follow-ups land in its own copy, and the scout's thread stays clean. Fork one per receiver — two consumers on one id queue into one timeline and see each other's turns.

## Fan-out

```text
arena/swarm: N workers [1]
└── fork S per worker → F1..FN  ← one dedicated crawler each [1a]
    └── worker i asks Fi  ← no two share a timeline [1a1]
```

## What S returns

**Report only. Name the answer, findings with `path:line` anchors, gaps with probes, and blockers.** S's reply is A's whole view of the codebase: A forked S to keep the crawl out of its window, so every line S returns spends the budget the fork was meant to save.

```text
S reply [1]
├── answer  ← direct, no preamble [1a]
├── findings [1b]  ← ≤ 15, one claim each
│   ├── id  ← F<n>, addressable so A can cite it [1b1]
│   ├── claim  ← one falsifiable assertion [1b2]
│   ├── anchor  ← `path:line` or `path:symbol` [1b3]
│   └── status  ← VERIFIED | INFERRED | STALE | UNVERIFIED [1b4]
├── gaps [1c]  ← ≤ 5, what S could not settle
│   ├── what  ← the claim left open [1c1]
│   ├── why  ← absent, unreadable, ambiguous, out of scope [1c2]
│   └── probe  ← the check that would settle it [1c3]
├── blockers  ← ≤ 3, and who resolves each [1d]
└── source  ← when C fetched one: path, repo, ref, sha [1e]
```

| Field | Holds | Must not hold |
|---|---|---|
| answer | the finding, direct | narration, restated task |
| claim | one assertion | multiple claims, hedging |
| anchor | `path:line` | file contents, grep output, directory listings, diffs |
| status | one tag | prose justification |
| gaps | missing item + probe | silence, invented claims |

**Hard limits.** ≤ 400 words, ≤ 60 lines. Pointers only — no file contents, grep output, directory listings, diffs, or command transcripts. A pointer may quote one line, and only when that line is the finding.

**Missing or unverifiable.** A claim with no anchor is `UNVERIFIED`; with no probe it is a gap, not a finding. Evidence older than the file's last change is `STALE`. A finding S could not produce goes under gaps — never omitted, never invented. Empty gaps means the crawl was complete: write `none`, do not drop the heading.

## Example reply

A scout asked *where request JWTs are validated*. Its reply, verbatim — illustration only, not a template to fill:

```text
answer
JWT validation lives in the requireAuth middleware, which verifies the signature and attaches the decoded user. Route handlers never check tokens themselves.

findings
F1  requireAuth() verifies the JWT signature.                               src/middleware/auth.ts:24    VERIFIED
F2  An expired token throws 401 before the handler runs.                    src/middleware/auth.ts:31    VERIFIED
F3  The signing secret is read from env at load; rotation needs a restart.  src/config/env.ts:12         INFERRED
F4  Session cookies are checked on a separate path from JWTs.               src/middleware/session.ts:8  STALE

gaps
what   whether refresh tokens are validated on this path
why    no refresh handler in the crawled area
probe  grep -rn refresh src/routes

blockers
none

source
none
```

Note the shape: `answer` answers in two sentences with no preamble; every finding is one claim with a `path:line` anchor and a status; the one thing the crawl could not settle sits under `gaps` with a probe A can run; `blockers` and `source` are present and say `none`. No file contents, no grep output, no narration — A pulls any file it wants from the anchors.
