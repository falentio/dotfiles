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

S's reply is the parent's whole view of the codebase, so it carries findings, not the crawl. Return only:

```text
S reply [1]
├── answer  ← the finding, direct, no preamble [1a]
├── evidence  ← file:line per claim, one line each [1b]
├── source  ← when C fetched one: path, repo, ref, sha [1c]
└── open  ← what S could not find, and why [1d]
```

- **Answer.** The question, answered. Name the symbol and the file it lives in. No "I searched for…" narration.
- **Evidence.** `path/to/file.ts:42` per claim. A claim without a pointer is dropped.
- **Source.** The cloner's path, repo, ref, and sha when the answer needed a dependency's source.
- **Open.** What S could not find, or a claim it could not verify. Empty when the crawl was complete.

Never paste file contents, grep output, or directory listings — the pointers stand in for them. Never restate the task. Keep it under a screen; the parent forked S to save its window, so a long reply defeats the fork.
