# harness-compaction

Replaces pi's summary compaction with the DeepSeek Harness (DSH) algorithm. Oversized tool results
shrink as they arrive and again while a request is built, and the oldest span is dropped instead of
being transcribed by a model. Retained messages continue verbatim, so the prompt cache in front of
them stays warm. The prune and drop paths make no provider call; the one deliberate exception is
`/compact <instructions>`, which returns nothing and lets pi's summarizer run.

## The order of operations

```text
a tool result arrives
└── tool_result hook
    ├── no token count since a compaction, or added result below the gate: unchanged
    └── the result would cross the gate: store head + marker + tail instead

pi builds a request
└── context hook
    ├── below the gate: untouched, the request is byte-identical to pi's
    └── at or above the gate: prune every oversized toolResult in the projection

pi checks its compaction trigger, after the tools and before the next response
└── session_before_compact
    ├── customInstructions present: return nothing, pi's summarizer runs
    └── otherwise: return pi's own cut with a fixed note and pi's file lists
```

The append-time prune is what lets the extension preempt the drop. pi decides from the stored
projection, so a result has to shrink before it lands; a prune that runs only while a request is
built never changes that decision.

## Two decisions

**Prune below pi's own trigger.** The gate is

```text
min(pruneAtRatio x contextWindow, contextWindow - reserveTokens), never below zero
```

The first term is DSH's `thresholdRatio`. The second is pi's compaction trigger, and the lower one
wins. Without it the ratio sits above pi's trigger on every window below 81,920 tokens at pi's
default reserve, so pi compacts first, `ctx.getContextUsage().tokens` becomes null, and the prune
never runs. `reserveTokens` comes from pi's merged settings in pi's own precedence: the
`compaction.modelOverrides["<provider>/<model id>"]` entry for the active model, then
`compaction.reserveTokens`, then pi's `DEFAULT_COMPACTION_SETTINGS` of 16,384.

At or above the gate, every `toolResult` whose text exceeds `thresholdChars` code points becomes its
first `headChars`, the marker, and its last `tailChars`. The append-time pass writes that into the
entry, so it is permanent. The request-time pass rewrites only the projection, so it is recomputed
for each request and disappears when pressure falls.

**Drop, never summarize.** `session_before_compact` returns pi's own cut
(`preparation.firstKeptEntryId`) with a fixed one-sentence note and pi's file lists from
`preparation.fileOps`. Pi still renders its summary wrapper, so the model sees a short note where the
dropped span was. When custom instructions are present, the hook returns nothing and pi's summarizer
runs.

## Settings it copies

`config.ts` is the only extension settings source: no environment variable or other file is read.
The factory validates it and throws on a config that cannot converge, rather than clamping.

| Field | Default | DSH name | Meaning |
| --- | --- | --- | --- |
| `enabled` | `true` | none | Off: every hook returns nothing and pi behaves as shipped. |
| `pruneAtRatio` | `0.8` | `thresholdRatio` | Fraction of the context window at which the prune starts, unless pi's reserve is closer. |
| `thresholdChars` | `8192` | `thresholdChars` | A tool result with more text code points than this is pruned. |
| `headChars` | `4096` | `headChars` | Leading code points kept. |
| `tailChars` | `1024` | `tailChars` | Trailing code points kept. |
| `marker` | `"\n\n[... tool result middle pruned ...]\n\n"` | `marker` | Text inserted where the middle was. |
| `droppedHistoryNote` | one sentence, see `config.ts` | none | The summary a compaction entry carries. |

Counts are Unicode code points, so a slice never splits a surrogate pair. Validation requires
`headChars + marker + tailChars` to stay below `thresholdChars`, because otherwise a pruned result
could be no smaller than its input.

pi's `compaction.reserveTokens` is read for the gate but is not an extension setting: pi owns it, and
the gate has to stay under the trigger pi checks.

## Files

| File | Role |
|---|---|
| `index.ts` | Wiring: the two prune hooks, `session_before_compact`, and the status command. Thin. |
| `config.ts` | Settings, defaults, validation, pi's reserve, and the gate predicates. |
| `prune.ts` | `measureText` and `pruneContent`. Pure, no pi imports. |
| `link.mjs` | Links the running pi install into `node_modules` so the in-process suites resolve it. |
| `test/prune.test.ts` | Unit tests for the slice arithmetic and its properties. |
| `test/wiring.test.ts` | Gate, append predicate, threshold, cut, file lists, fallback, config, and no-model tests against a fake pi. |
| `smoke.test.ts` | Eight real pi runs against a faux model, one of them through RPC mode. |
| `smoke/faux-provider.ts` | The faux model: three reads of `big.txt`, then DONE. |

Run `/harness-compaction` in a session to report the gate, the current usage, pi's reserve, and the
slice sizes.

## Run the tests

```sh
cd .pi/agent/extensions/harness-compaction

# Links the running pi install, then runs 39 tests in-process, no model call, about a second.
node link.mjs && node --test test/*.test.ts

# Eight real pi runs, about four seconds.
node link.mjs && node --test smoke.test.ts

# TypeScript over every file in the package.
node link.mjs && tsc --noEmit
```

`link.mjs` links pi, its pi-ai, and jiti into the package's `node_modules` the same way the sibling
extensions do. The suite imports `estimateTokens` from pi at runtime, so the link is required;
`node link.mjs` is safe to re-run. `tsconfig.json` pins the program to that linked pi-ai, because
`test-support/faux-message.ts` would otherwise resolve a second copy from a parent `node_modules`.

The smoke suite passes `-e smoke/faux-provider.ts --provider faux --model faux-1 --tools read` and
drives the CLI resolved by `../../test-support/pi-install.mjs`, so it needs no auth and makes no
network call. It runs seven scenarios in print mode plus one in RPC mode: the byte comparison needs a
large-window baseline as well as a large-window extension run. Every scenario gets its own project,
session, and log directory.

The fixture is a 43,200-byte `big.txt` and a project `.pi/settings.json` with `keepRecentTokens: 600`
and, for the small scenarios, `reserveTokens: 200`. Each run passes `-a`, because pi loads project
settings only for a trusted project. The gate scenarios leave `reserveTokens` out and so run at pi's
own default.

The gate scenarios use a 24,000-token window. A 43,200-byte read is about 10,800 tokens, which is
more than the gate at 24,000 (7,616) and less than the gate at 32,000 (15,616). At 32,000 the first
read therefore fits whole and the second one crosses pi's trigger even after it is pruned; the
24,000 window is the smallest one where a single read is over the gate, which is the case the
append-time prune exists for. The faux provider also counts a request's cache write twice in the
usage it reports, so a larger window reads more pressure than it has.

## The measured runs

One run on this machine with pi 1.4.0. Token counts are the faux provider's estimates. pi's baseline
can compact one more or one fewer time between runs, and the cache totals drift by a few tokens, so
the marker, summary, and stored-result columns are the stable ones.

| Run | Summary calls | Compactions | Requests with marker | cacheWrite | cacheRead | Biggest request |
| --- | --- | --- | --- | --- | --- | --- |
| Small window, extension | 0 | 1 | 3 | 4,687 | 3,471 | 10,815 |
| Small window, no extension | 4 | 4 | 0 | 22,427 | 13,037 | 44,185 |
| Small window, padded prompt, extension | 0 | 2 | 3 | 6,384 | 4,858 | 12,084 |
| Gate window, extension | 0 | 0 | 3 | 4,635 | 6,087 | 16,181 |
| Gate window, no extension | 4 | 4 | 0 | 22,427 | 13,036 | 44,185 |
| Large window, extension | 0 | 0 | 0 | 33,168 | 34,618 | 131,879 |
| Large window, no extension | 0 | 0 | 0 | 33,170 | 34,625 | 131,879 |
| Gate window, RPC, extension | 1 | 2 | 3 | 4,689 | 3,477 | 10,815 |

The gate rows are the regression: without the extension the same window summarizes four times, with
it the prune keeps every request under pi's trigger and no compaction runs. The large rows match in
request bytes, and their cache totals differ only by the few tokens the extension's own registered
command adds to the system prompt.

The RPC row is the custom-instructions path: the threshold compaction carries the note, and the
manual `/compact` with instructions makes exactly one summary call and stores pi's own entry
(`fromHook: false`).

## Known limits

- The append-time prune is permanent: it lands in the session entry, so the original result is gone
  from the log. The request-time prune never writes, so what it removed returns when pressure falls.
- `ctx.getContextUsage().tokens` is null right after a compaction. A result stored in that window is
  kept whole; the next request prunes it in the projection until pressure falls.
- Only text blocks are rewritten. Image blocks pass through with their fields, in order.
- A drop removes the oldest span from the projection, tool calls included. The session log keeps
  every entry, but the model can no longer see that part of the conversation.
- A prune changes the first token after the kept head, so cache reuse stops there. The DSH pruner
  README makes the same claim about replacing an earlier result.
- The compaction entry's `details` records the files pi saw. pi seeds the next compaction's file
  tracking only from its own entries (`fromHook: false`), so these lists are the record of this drop,
  not a cumulative trail.
- Dropping instead of summarizing is a product choice, not a DSH port end to end. DSH's
  `compaction-basic` always replaces the oldest balanced span with one summary message.
