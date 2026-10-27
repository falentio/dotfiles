# Smoke suite

Four scenarios through a real `createAgentSession`, each on its own temp `agentDir`. `run.ts` copies the extension and the shared `faux-provider.ts` into that directory, loads the faux provider, then drives the session until it compacts.

Run it with:

```sh
bun run test smoke
```

`bun run test` first links the current pi install into `node_modules`, then runs `bun --no-install test`. The script passes `--no-install` so Bun cannot fetch a second copy of `@earendil-works/pi-ai`, where the faux provider would register into an instance pi never reads.

The provider is pi-ai's own double: `registerFauxProvider` from `@earendil-works/pi-ai`. The response factory records each request, calls the test-only `bloat` tool, and answers summaries with `SUMMARY_MARKER`. It also strips the prompt-cache session id, because faux counts `cacheWrite` inside `input` and the double-count would move every compaction threshold.

## Scenarios

| Test | Setup | Asserts |
| --- | --- | --- |
| compacts from the precomputed summary | defaults | one summary request, one compaction from the hook, `start:manual` first |
| baseline | extension absent | the threshold compacts, `fromHook` is false, the summary follows |
| holds the summary | `compactWhenReady: false` | a summary is written, no compaction comes from the hook |
| drops a stale tail | `keepRecentTokens` and `tailMin` at 1000 | summaries are written, none is used |

## Why the harness masks pi-ai

`loadFauxProvider` registers pi's own module paths as jiti aliases, the same map pi's loader builds. Pi loads extensions through jiti with those aliases, so an extension that imports `@earendil-works/pi-ai/compat` reaches the same registry pi holds. Load the provider any other way and it registers into a second copy of the package, where `registerApiProvider` succeeds and every request still fails with "No API provider registered".

The linker is `test-support/pi-install.mjs`. It finds the newest install under `~/.vite-plus` (or takes `PI_INSTALL`) and symlinks it into `node_modules`. It runs before `bun test` because Bun resolves a test file's imports before any preload, so a `bunfig.toml` preload is too late. The session the test creates and the provider the extension registers then share one copy.

## Restart

`restart.test.ts` drives one session to a compaction, closes it, then reopens the same session file from a second `SessionManager.open`.

Across the reopen the suite asserts one summary request in total and one compaction record, identical to the first process. The precompute held in memory dies with the process; the compaction entry does not, and pi's own post-compaction accounting keeps the reopened branch below the threshold.

Where the restart boundary sits, and why the memory-only precompute costs nothing in the common case:

- After a compaction the branch is short again, so a reopened process sits far below the gate and starts no summary.
- A summary that is ready but not yet used is memory-only, and a restart drops it. `test/wiring.test.ts` pins that: `session_start` clears the state, the next settle issues a second request, and no entry is written for it.
