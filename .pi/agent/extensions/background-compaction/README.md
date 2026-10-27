# Background compaction

Writes the compaction summary while the agent settles, then compacts the session before the next prompt. The user never waits for a summary.

## Behavior

The extension starts a summary when estimated context reaches 85% of the compaction ceiling, and the ceiling is at least 64k tokens. The summary covers the prefix a normal compaction would replace. Every message after the cut stays verbatim.

When the summary is ready, the agent is idle, and no messages are pending, the extension calls `ctx.compact()`. The next prompt runs on the compacted context.

A `/compact` without instructions uses a ready summary, so it completes without another summary call.

## Configuration

`config.ts` is the only settings source. Edit `PRECOMPUTE_CONFIG` there.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turns every summary call, compaction, and status write off. |
| `compactWhenReady` | `true` | Summaries are still written when false, but the extension never compacts. |
| `compactAtRatio` | `0.85` | Fraction of the ceiling that starts a summary. |
| `minCeilingTokens` | `64000` | Windows below this ceiling never precompute. |
| `reserveTokens` | `16384` | Mirrors pi's compaction reserve. |
| `keepRecentTokens` | `20000` | Tail kept verbatim. |
| `tailShare` | `0.25` | Tail limit as a fraction of the ceiling. |
| `tailMin` | `30000` | Floor for the tail limit. |
| `maxFailures` | `2` | Failed summaries before the session stops retrying. |

The tail limit is `min(max(2 * keepRecentTokens, tailMin), tailShare * ceiling)`. The gate is `compactAtRatio * ceiling`.

## Skip reasons

A ready summary is dropped when the compaction would be incorrect or too large:

- `not-ready`: no summary is held.
- `custom-instructions`: a `/compact` carried instructions.
- `model-changed`: the model changed after planning.
- `baseline-changed`: another compaction landed after planning.
- `branch-changed`: a covered entry or the keep entry left the branch.
- `tail-too-big`: the kept tail grew past the limit.

When a summary is dropped, pi's threshold compaction takes over with a fresh cut.

## Command

`/precompute` reports the state, tokens, gate, ceiling, keep entry, tail tokens, and failure count. `/precompute force` starts a summary below the gate when the agent is idle.
