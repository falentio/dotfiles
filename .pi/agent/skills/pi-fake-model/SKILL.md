---
name: pi-fake-model
description: "Use when writing or debugging a pi extension that calls a model — `ctx.model`, `complete()`, `ctx.compact()`, a provider registration, or compaction/summarization work — so the call runs against a test double, never a paid provider."
---

# Pi Fake Model

A pi extension's model call runs against a **double**: a fake that answers where a provider would. A double costs nothing and answers the same way every run.

Every extension path resolves through the provider registry — `ctx.modelRegistry.find()`, `complete()`, `ctx.compact()`, and `pi.registerProvider()` all end at a model record with a `baseUrl`, an `api` adapter, or a `streamSimple`. Replacing that one record redirects every call the extension makes.

Run the commands below from this skill's directory.

## Pick the seam

The **seam** is where the double plugs in. Everything above it stays real.

| What you are testing | Seam | Double |
|----------------------|------|--------|
| Extension logic: prompt building, compaction prep, tool-call handling | `streamSimple` | `fauxProvider` from `@earendil-works/pi-ai` |
| Wire behavior: SSE parsing, tool-call deltas, aborts, retries, headers | HTTP + SDK | `assets/mock-server.mjs` behind `baseUrl` |
| Whether the summary actually reads well | none | llama.cpp router |

Reach for `fauxProvider` first. Move to the HTTP double only when the adapter itself is what you suspect.

## Steps

### 1. Wire the double

Stream seam, inside the extension under test:

```typescript
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux 1" }] });
faux.setResponses(Array.from({ length: 64 }, () => fauxAssistantMessage("fake answer")));
pi.registerProvider(faux.provider);
```

Swap the message for a factory, `(context) => fauxAssistantMessage(...)`, and the answer can branch on `context.messages`.

```bash
pi -e <your-extension.ts> --provider faux --model faux-1 --no-builtin-tools -p "hi"
```

**Done when** that command prints an answer from the double.

Wire seam:

```bash
node assets/mock-server.mjs --port 8899 --script assets/script.json --log requests.jsonl &
pi -e assets/mock-provider.ts -e <your-extension.ts> \
   --provider mock --model mock-1 --no-builtin-tools -p "hi"
```

**Done when** that command prints an answer from the double and `requests.jsonl` holds one entry.

### 2. Drive the real path

Use RPC mode, not `-p`, whenever the flow continues past one turn. `-p` tears the session down, and a compaction started from that session dies with it (`Compaction cancelled`).

`assets/drive-rpc.mjs` is the template: N prompts over `pi --mode rpc`, then the native `{"type":"compact"}` command. Copy it, change the prompts, the `-e` list, and `--provider`/`--model`.

For a compaction fixture, give pi a small window and a short keep-tail in the project it runs from:

```bash
mkdir -p /tmp/fixture/.pi
printf '%s\n' '{"compaction":{"enabled":true,"reserveTokens":100,"keepRecentTokens":100}}' \
  > /tmp/fixture/.pi/settings.json
```

**Done when** every scenario turn reports `turn ok` and compaction reports `compact ok: true` with `tokensBefore` and `estimatedTokensAfter` filled in.

### 3. Account for every call

The wire double appends one JSONL entry per model request, with the exact `messages`, `tools`, and `stream` flag pi sent. Read the tail of the log, not the console.

**Done when** every log entry is a call the scenario was meant to make, no entry carries a model id you did not register, and — on the stream seam — `faux.getPendingResponseCount()` fell by exactly the call count. A count that did not fall means no call ran; a drop you cannot match to a step means the extension called the model somewhere you have not accounted for.

## Traps

- `compaction.keepRecentTokens` (default 20 000) gates compaction before the first model call. A fixture session under that size fails with `Nothing to compact (session too small)`.
- Project settings load from pi's working directory. Spawn pi inside the fixture project, not the extension's folder.
- The faux queue pops one entry per model call. Running dry surfaces as `No more faux responses queued`, not as a network error.
- The mock server reads its script once at startup; restart it after editing replies.
- Compaction issues two requests when the cut splits a turn: the `<conversation>` summary and a turn-prefix summary.
- `options.fetch` is a third seam: it keeps the real adapter and fakes only the `Response`, when a socket is unwanted.

## Files

| Path | Use |
|------|-----|
| `assets/mock-server.mjs` | OpenAI-compatible SSE server, no dependencies |
| `assets/mock-provider.ts` | registers it as `mock/mock-1` |
| `assets/drive-rpc.mjs` | RPC driver template: turns, then compaction |
| `assets/faux-probe.ts` | faux provider with a prompt-dependent response factory |
| `assets/script.json` | scripted replies, matched by regex |
| `assets/run.sh` | end-to-end self-check of both seams |

Evidence, the wire contract, and the published-alternative comparison: `~/Repositories/yap/research/technology/pi-extension-mock-llm.md`.
