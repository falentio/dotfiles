# nested-agents

Injects the nested `AGENTS.md` files that govern a file, at the moment a tool touches it.

Pi already loads `AGENTS.md` from your working directory and every ancestor above it. It does not
load them from subdirectories. This extension fills that gap: read `packages/api/handler.ts` and the
`AGENTS.md` files in `packages/` and `packages/api/` are appended to the read result.

## Files

| File | Role |
|---|---|
| `index.ts` | Wiring: subscribes to `session_start` and `tool_result`. Thin. |
| `config.ts` | Settings: context-file names, pruned directories, entry type, trigger tools. |
| `logic.ts` | All rules, pure and testable. No pi imports. |
| `logic.test.ts` | Unit tests for the rules. |
| `handler.test.ts` | Handler tests against a fake pi. |
| `smoke.test.ts` | Drives the real pi binary with a fake model; asserts on the session transcript. |
| `smoke/faux-provider.ts` | The fake model: answers the read and edit calls the prompts ask for. |
| `EVIDENCE.md` | The measurements and real-run logs behind the design. |

## Run the tests

```sh
cd ~/.pi/agent/extensions/nested-agents

# Fast: 122 tests, no model calls, about a second.
node --test logic.test.ts handler.test.ts compaction.test.ts

# Slow: 8 tests, real pi runs with a fake model, about 10 seconds.
node --test smoke.test.ts
```

The smoke suite passes `-e smoke/faux-provider.ts --provider faux --model faux-1`, so it needs no auth and makes no network call. It runs the CLI of the install `test-support/pi-install.mjs` resolves, the same install the other suites link, so `PI_INSTALL` pins it and `PI_BIN` overrides the command outright.

## Behaviour

- **Triggers on `read`, `write`, and `edit`.** The edit tool reads the file through its own fs call,
  not through the read tool, so a model that edits without reading first still needs the context.
- **Only files strictly below the working directory.** Ancestor files are already in the system
  prompt, so injecting them would duplicate context.
- **Whole chain, outermost first.** A parent package's rules govern a nested file too, so both
  `packages/AGENTS.md` and `packages/api/AGENTS.md` are injected, broad scope before narrow.
- **Delivered once per content revision.** Dedup is keyed on a content hash, not the path, so an
  edited instruction is re-sent and an unchanged one is not.
- **Survives resume.** Delivered hashes are recorded as transcript entries, so a resumed session
  does not re-inject.

## Pruned directories

The walk never descends into a directory whose name is in `PRUNE_DIRS` (in `config.ts`), grouped by
the ecosystem that produces it: JS package managers, Rust, Haskell, Go, Elixir, Zig, Python, JVM,
Apple, Dart, and the build output of Next, Nuxt, SvelteKit, Astro, Angular, Nx, Vite, Parcel, Remix,
Expo, Storybook, Umi, Docusaurus, Fresh, SolidStart, the SSGs, the serverless platforms, and
Terraform.

The prune rule is a **hard stop**: a file anywhere inside a pruned subtree gets no context, not just
the pruned directory's own instructions. A false positive therefore breaks injection for an entire
source tree, so the list holds only names that are essentially never source.

Deliberately **not** pruned, because they are real source in ordinary repos: `lib`, `public`,
`assets`, `static`, `bin`, `pkg`, `docs`, `scripts`, `examples`, `packages`, `www`, `tmp`,
`log`, `logs`, `.storybook`, `.vitepress`, and any config directory.

To add or remove a name, edit `PRUNE_GROUPS` in `config.ts` and add a case to the `PRUNE_DIRS`
suite in `logic.test.ts`. The set is derived from the groups, so the two cannot drift.


## The no-duplicate guarantee

The same file is never injected twice into one session, including across a resume in a **new
process**, across a **fork**, and across a **compaction**. Four mechanisms provide it.

**Identity dedup.** Files are keyed by canonical (realpath) identity, so one file reached through
two logical paths, a symlinked directory, or a `..` segment is one record. The logical path is still
what the model sees in the injected block.

**Per-batch dedup.** One injection covers a whole chain. When a parent and a child directory link
to the same file, the chain has two entries with one identity; the batch claims each identity once,
so the file appears once in the block.

**Rebuild, never merge.** The delivered map is *replaced* on `session_start` (which fires for
startup, new, resume, reload, and fork) and on `session_compact`, from the transcript itself, using
two redundant sources:

1. the `nested-agents-injected` marker entries the extension appends;
2. the `<project_instructions>` blocks still present in tool results.

The second source is redundant by design. The block *is* the record: if the text is still in
context, the model still has those instructions. Reading both means the two cannot disagree.

**Atomic handlers.** The `tool_result` handler contains no `await`, so two parallel tool calls in
one message cannot interleave between reading the delivered map and writing it.

The asymmetry is deliberate. A duplicate wastes tokens. A **miss** is worse: the model edits with
stale or absent rules. Every ambiguous case resolves toward re-injecting.

`compaction.test.ts` pins this against pi's real `buildContextEntries`. It also pins a fact worth
knowing: a plain `custom` entry projects to zero context messages, so a marker can never be a
compaction cut point, which is why a compaction cannot drop a marker while keeping its block. If a
future pi widens the cut-point rules, that test fails rather than the guarantee breaking silently.
## Known limitations

- **Reads through bash are not covered.** `cat foo.ts` fires `tool_result` with no path, so nothing
  is injected. Closing this needs shell-command parsing.
- **Compaction is not fully handled.** Dedup reads the compaction-aware transcript view, which is
  more correct than the full branch, but the injected block rides in a tool result that compaction
  can summarise away. A `session_compact` handler that re-injects would close it. Not yet verified
  by a real compaction run.
- **No byte budget.** Bounded in practice by "below cwd" plus once-per-revision delivery.
