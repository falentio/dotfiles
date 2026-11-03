# idle-compact

Compacts the conversation before sending the first prompt that arrives after an
idle hour, so that prompt writes a prompt cache for the summary and the recent
tail instead of for the whole transcript.

## The problem

A provider prompt cache lives about an hour. Answer a prompt within the hour
and the next request reads the transcript prefix from that cache at the cheaper
rate. Come back later and the cache is gone, so the next request pays a cache
write for every token in the transcript, including the tokens the conversation
had already forgotten the point of.

The summarization request pi sends for a compaction carries no prompt-cache
write. That makes the compaction the cheap moment to shrink the prefix: one
uncached summary request replaces a cache write over the whole transcript, and
the prompt that follows writes a cache for the summary plus the kept tail.
Every later turn in that session reads the smaller cache.

The saving is the difference between writing a cache for the whole transcript
and writing one for the compacted prefix. A session that continues for many
turns after the idle gap is where it shows up.

## When it compacts

pi hands an input to the extension before it expands skills and templates and
before it starts the run. The extension takes the prompt only when every guard
holds:

| Guard | Reason |
| --- | --- |
| `enabled` | the extension can be turned off |
| no compaction in flight | a second prompt during a compaction is never swallowed |
| the input is not from an extension | the re-sent prompt must not be swallowed again |
| nothing streaming or queued | a run in progress already owns the next request |
| `idleMs` elapsed since the run settled | a warm cache needs no compaction |
| at least `minTokens` in the context | a small transcript is not worth summarizing |
| non-blank text | there is nothing to re-send |

On a take, the extension returns `{ action: "handled" }`, so pi sends nothing,
and runs `ctx.compact()`. The compaction then either completes or fails. Both
endings re-send the prompt through `sendUserMessage`, with
`expandPromptTemplates` on, so `/skill:name` and prompt templates still
expand. The re-sent prompt starts the turn pi would have started, one uncached
summary request later.

The prompt is never lost. A failed compaction, a "Nothing to compact (session
too small)" error, and a cancelled compaction all reach the same re-send.

The phase is one value: either `watching`, with the time the run settled, or
`compacting`, holding the prompt that was taken. A session restore seeds the
settle time from the newest assistant message in the branch, so reopening an
old session after a break compacts before the first prompt too.

## Configuration

The settings live in `config.ts` and nowhere else. It is not a JSON file and
no environment variable is read.

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | whether an idle prompt is compacted first |
| `idleMs` | `3600000` | how long the session sits settled before a prompt is compacted first |
| `minTokens` | `40000` | the smallest context, in tokens, worth compacting |

An hour matches the default prompt-cache lifetime. `minTokens` keeps a short
conversation from paying for a summary it does not need.

## Limits

A prompt sent while the compaction runs is queued by the TUI and rejected by pi
in RPC and print mode with "Cannot submit a prompt while compaction is in
progress". The extension does not work around either: the compaction holds the
session, and the queue drains after it.

Esc during the compaction cancels it and pi reports the compaction as aborted.
The extension still re-sends the prompt, so the turn happens against the
uncompacted transcript. The next idle prompt may compact instead.

The extension never compacts below `minTokens`, so a long cold session under
that floor still writes a cache for its whole transcript.

pi's own compaction threshold is independent. A context that crosses it during
a run is compacted by pi, not by this extension.

## Develop

pi provides the `@earendil-works` packages at runtime, so the extension runs
with no install. For `bun test` and `tsc`, the shared linker symlinks the
current pi install into `node_modules`. Both scripts run it first:

```sh
bun run test        # links pi, then the suite
bun run typecheck
```

The unit suite covers every guard in `decide()`. The smoke suite drives a real
`AgentSession` against a faux provider: it sends one prompt, waits for the
session to settle past the rewritten `idleMs`, sends a second prompt, and
asserts that one manual compaction ran, that a summary request went out, that
the last request carries both the summary and the swallowed prompt text, and
that it carries fewer messages than the same exchange without the extension.
