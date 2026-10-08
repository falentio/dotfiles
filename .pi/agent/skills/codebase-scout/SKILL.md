---
name: codebase-scout
description: "Read and search a codebase through a delegated scout thread, not in the main context. Use when you need to understand code, grep across many files, or answer where things live, and when several subagents need the same codebase knowledge."
---

# Codebase scout

Never crawl the codebase in the main context. A crawl is file reads and grep output; it crowds the window and buries the answer. Send a **scout** — a delegated thread that reads the codebase and reports — and reuse it.

## Delegate the crawl

`tools.mcp__t3_code__delegate_task` one scout per area: where a symbol lives, how a flow works, which files a change touches. Record the returned `childThreadId`. The parent keeps the scout's answer, not its file reads.

## Reuse the scout

A scout that has read the codebase knows more than a fresh subagent. Hand its thread id to the subagents that follow — an implementer, a researcher, a reviewer — so they ask the scout instead of re-reading.

**Fork before handoff.** A thread is one conversation: two consumers sending to one id queue into one timeline and see each other's turns. Fork first, hand off the fork, so each consumer follows up in its own copy.

```js
const fork = JSON.parse(await tools.mcp__t3_code__t3_thread_fork({
  threadId: scoutThreadId,
  sourcePoint: { type: "latest_stable" },
  title: "scout for implementer",
}));
// hand fork.targetThreadId to the consumer
```

The fork inherits everything the scout learned and is independent: a consumer's follow-ups land in its own copy, and the scout's thread stays clean.

## Steps

1. Delegate the crawl. One scout per area. Record `childThreadId`.
2. Fork per consumer. Before handing the id to any other subagent, fork it and pass `targetThreadId`.
3. Follow up. A consumer messages its forked id with `tools.mcp__t3_code__t3_thread_send`; the fork still knows what the scout read.
