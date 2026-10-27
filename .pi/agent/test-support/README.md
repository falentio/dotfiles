# Extension test support

`pi-install.mjs` finds the running pi install and links it into the `node_modules` of the extensions whose tests run in-process. It exists because a pi install lives under a hash directory that changes on every update:

```text
~/.vite-plus/packages/@earendil-works/pi-coding-agent/<hash>/lib/node_modules/@earendil-works/pi-coding-agent
```

The helper takes the newest install, or `PI_INSTALL` when set. `piAliases` returns the same path map for jiti and Node loaders, so a test's session and an extension's provider register into one copy of `pi-ai`.

The linker refuses to delete a real directory where a link belongs: it stops and names the path, so a `node_modules` from a real install survives.

`link-pi.mjs` runs the linker for `background-compaction`, `repo-scout`, `todos`, and `test-support` itself, and every suite that imports pi in-process calls it from its `test` and `typecheck` scripts. The `nested-agents` suites need no link: they drive the real `pi` CLI in its own process. Run `bun test` directly only after one link; Bun resolves a test file's imports before any preload, so a `bunfig.toml` preload is too late on a clean checkout.

## Suites on the faux model

| Suite | Command | Result | Time |
| --- | --- | --- | --- |
| `nested-agents` unit | `node --test logic.test.ts handler.test.ts compaction.test.ts` | 122 pass | 0.6s |
| `nested-agents` smoke | `node --test smoke.test.ts` | 8 pass | 7.9s |
| `background-compaction` | `bun run test` | 148 pass | 41.2s |
| `repo-scout` | `bun run test` | 126 pass | 4.2s |
| `todos` | `bun run test` | 113 pass | 0.4s |

Measured against pi 1.4.0. The `nested-agents` smoke drives the real `pi` binary with a faux provider; every other suite runs in-process. No suite reaches a real provider, a network, or credentials.
