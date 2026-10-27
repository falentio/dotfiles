# Smoke suite

Four scenarios through a real `createAgentSession`, each on its own temp `agentDir`. `run.ts` copies the extension and `mock-provider.ts` into that directory, loads the mock provider, then drives the session until it compacts.

Run it with:

```sh
bun --no-install test smoke
```

`--no-install` matters. Without it Bun may resolve `@earendil-works/pi-ai` a second time, and the mock provider then registers into an instance pi never reads.

## Scenarios

| Test | Setup | Asserts |
| --- | --- | --- |
| compacts from the precomputed summary | defaults | one summary request, one compaction from the hook, `start:manual` first |
| baseline | extension absent | the threshold compacts, `fromHook` is false, the summary follows |
| holds the summary | `compactWhenReady: false` | a summary is written, no compaction comes from the hook |
| drops a stale tail | `keepRecentTokens` and `tailMin` at 1000 | summaries are written, none is used |

## Why the harness masks pi-ai

`loadMockProvider` registers pi's own module paths as jiti aliases, the same map pi's loader builds. Pi loads extensions through jiti with those aliases, so an extension that imports `@earendil-works/pi-ai/compat` reaches the same registry pi holds. Load the provider any other way and it registers into a second copy of the package, where `registerApiProvider` succeeds and every request still fails with "No API provider registered".
