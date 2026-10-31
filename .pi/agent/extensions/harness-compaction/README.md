# harness-compaction

Replaces pi's summary compaction with the DeepSeek Harness (DSH) algorithm. Instead of asking a model
to transcribe the old history, the extension prunes oversized tool results in place and, when that is
not enough, drops the oldest span. The retained messages continue verbatim, so the prompt cache in
front of them stays warm. No provider call is made, so there is nothing to bill.

```text
model request
└── context hook
    ├── ctx.getContextUsage()
    ├── below pruneAtRatio x window: return untouched
    └── at or above the gate: prune every oversized toolResult in the projection

pi decides it must compact
└── session_before_compact
    ├── customInstructions present: return nothing, pi's summarizer runs
    └── otherwise: return pi's own cut with a fixed note
```

## Two decisions

**Prune only under pressure.** The `context` hook compares `ctx.getContextUsage()` to
`pruneAtRatio` of the model's window. Below the gate it returns nothing, so the request is
byte-identical to pi's. At or above the gate, every `toolResult` whose text exceeds
`thresholdChars` code points becomes its first `headChars`, the marker, and its last
`tailChars`. The prune is a projection: it is recomputed for each request and never written to the
session log, so the original results stay replayable and the prune disappears when pressure falls.

**Drop, never summarize.** `session_before_compact` returns pi's own cut
(`preparation.firstKeptEntryId`) with a fixed one-sentence note. Pi still renders its summary
wrapper, so the model sees a short note where the dropped span was. When custom instructions are
present, the hook returns nothing and pi's summarizer runs.

## DSH defaults it copies

`config.ts` is the only settings source. The factory validates it and throws on a config that
cannot converge, rather than clamping.

| Field | Default | DSH name | Meaning |
| --- | --- | --- | --- |
| `enabled` | `true` | none | Off: both hooks return nothing and pi behaves as shipped. |
| `pruneAtRatio` | `0.8` | `thresholdRatio` | Fraction of the context window at which the projection is pruned. |
| `thresholdChars` | `8192` | `thresholdChars` | A tool result with more text code points than this is pruned. |
| `headChars` | `4096` | `headChars` | Leading code points kept. |
| `tailChars` | `1024` | `tailChars` | Trailing code points kept. |
| `marker` | `"\n\n[... tool result middle pruned ...]\n\n"` | `marker` | Text inserted where the middle was. |
| `droppedHistoryNote` | one sentence, see `config.ts` | none | The summary a compaction entry carries. |

Counts are Unicode code points, so a slice never splits a surrogate pair. Validation requires
`headChars + marker + tailChars` to stay below `thresholdChars`, because otherwise a pruned result
could be no smaller than its input.

## Files

| File | Role |
|---|---|
| `index.ts` | Wiring: the `context` hook, `session_before_compact`, and the status command. Thin. |
| `config.ts` | Settings, defaults, validation, and the two pure predicates over them. |
| `prune.ts` | `measureText` and `pruneContent`. Pure, no pi imports. |
| `test/prune.test.ts` | Unit tests for the slice arithmetic and its properties. |
| `test/wiring.test.ts` | Gate, threshold, cut, fallback, config, and no-model tests against a fake pi. |
| `smoke.test.ts` | Four real pi CLI runs against a faux model. |
| `smoke/faux-provider.ts` | The faux model: three reads of `big.txt`, then DONE. |

Run `/harness-compaction` in a session to report the gate, the current usage, and the slice sizes.

## Run the tests

```sh
cd .pi/agent/extensions/harness-compaction

# Fast: 28 tests, no model call, no node_modules link, about 150 ms.
node --test test/*.test.ts

# Slow: 4 tests, four real pi runs, about 2 seconds.
node --test smoke.test.ts
```

The smoke suite passes `-e smoke/faux-provider.ts --provider faux --model faux-1 --tools read` and
drives the CLI resolved by `../../test-support/pi-install.mjs`, so it needs no auth and makes no
network call. It runs four scenarios, not three: the byte-for-byte comparison needs a large-window
baseline as well as the large-window extension run. The small-window baseline compacts, so its
request log cannot be the comparison.

The fixture is a 43,200-byte `big.txt` and a project `.pi/settings.json` with `reserveTokens: 200`
and `keepRecentTokens: 600`. The small scenarios use a 6,000-token window, the large ones 900,000.
Each scenario gets its own session and log directory.

## The four runs

Measured on pi 1.4.0 with the defaults above. Token counts are the faux provider's estimates.

| Run | Summary calls | Compactions | Requests with marker | cacheWrite | cacheRead | Biggest request |
| --- | --- | --- | --- | --- | --- | --- |
| Small window, extension | 0 | 2 | 1 | 12,891 | 13,014 | 44,186 |
| Small window, no extension | 2 | 2 | 0 | 33,245 | 2,173 | 44,225 |
| Large window, extension | 0 | 0 | 0 | 33,165 | 34,610 | 131,879 |
| Large window, no extension | 0 | 0 | 0 | 33,165 | 34,610 | 131,879 |

No summary call, and the retained prefix is read from cache instead of written again. The last two
rows match in request bytes and cache totals, so the extension does nothing below the gate.

The cache totals differ from section 4 of the build brief because that table was measured with the
prototype's 3000/2000/600 slice. This extension ships the DSH defaults, so its pruned request is
larger: 5,454 bytes against 2,894. Compaction counts and the biggest request per run match.

## Known limits

- `ctx.getContextUsage().tokens` is null right after a compaction. The next request goes unpruned
  until a response reports usage, so a large result retained by the cut is sent whole once.
- Only text blocks are rewritten. Image blocks pass through with their fields, in order.
- A drop removes the oldest span from the projection, tool calls included. The session log keeps
  every entry, but the model can no longer see that part of the conversation.
- A prune changes the first token after the kept head, so cache reuse stops there. The DSH pruner
  README makes the same claim about replacing an earlier result.
