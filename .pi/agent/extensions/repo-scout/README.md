# repo-scout

Two tools that replace the scout-subagent dance with one call.

| Tool | Takes | Returns |
|---|---|---|
| `repo_scout` | a repo (URL, `host/owner/name`, `owner/name`, or a local path), a question, and optionally a `ref` | the scout report: `answer`, findings anchored to `path:line`, gaps, blockers, and the checkout/commit that answered |
| `package_repo` | a package name, a `source` (`npm`, `jsr`, `crate`, `pypi`, `dockerhub`), and optionally a `version` | the git repo URLs that serve it, each with provenance, a confirmed git `ref`, and the exact clone target |

Both are `codemode` tools, so they are reached from codemode scripts:

```js
const at = await tools.package_repo({ package: "zod", version: "4.0.7" });
// clone    https://github.com/colinhacks/zod ref=v4.0.7

const report = await tools.repo_scout({
  repo: "https://github.com/colinhacks/zod",
  ref: "v4.0.7",
  question: "How does it validate a date-time?",
});
```

## One session per repo, ref, model, and thinking level

A conversation is keyed by four things: the canonical repo identity (`github.com/owner/name`,
lowercased, `.git`/query/fragment stripped; a local checkout is keyed by its `origin`, so a worktree,
the main clone, and the https URL all share one session), the `ref`, the model, and the thinking
level. Change any of them and you get a different conversation, because an `AgentSession` is bound to
the model it opened with.

A **`ref`** is part of the key: `github.com/o/n@v4.0.7` is a different conversation from
`github.com/o/n`. Two refs are two trees, so they never share a checkout, a conversation, or a report.
A pinned tree is built with `git init`, `git remote add`, a fetch of the ref, and a checkout of
`FETCH_HEAD`; a branch, a tag, and a commit all work, where `clone --branch` accepts only the first
two. The ref is validated as a plain git ref name first: `git fetch` reads a leading `-` as an
option, and `--upload-pack=<cmd>` would run a command on this host.

That session is the point. Every later question about the same repo appends to the same conversation,
so the provider's prompt cache is reused instead of re-crawling from zero, and the report comes back
with `turn continued` instead of `turn opened`.

- **One question at a time.** Further questions queue in a FIFO behind the running one. Different
  repos run in parallel. A question is rejected only when the session is evicted or the process shuts
  down, and a turn that exceeds `PI_SCOUT_TURN_MS` (15 minutes) is aborted.
- **The caller can cancel.** Aborting the tool call aborts the scout's turn.
- **Ten idle minutes, then evicted.** The clock restarts when a question settles, so a long crawl is
  never evicted mid-run. Eviction disposes the session.
- **Eviction does not lose the cache.** The conversation is persisted, so the next question reopens
  that file and continues the same history. A new conversation is only started the first time.

## What the scout is

- **The caller's model.** `ctx.model` with the caller's `ModelRegistry`, so it authenticates exactly
  as the asking thread does. `model: "provider/id"` overrides it; `thinkingLevel` defaults to medium.
- **Read-only.** `read`, `grep`, `find`, `ls`. No bash, no edit, no write.
- **Only the scout skills.** The resource loader has extensions, themes, context files, and prompt
  templates switched off, so loading this extension inside its own scout cannot recurse.
- **A report, not a dump.** The first message carries the report contract from
  `skills/codebase-scout`: 800 words, pointers only, no file contents or grep output.

## The checkout it reads

Never your working tree: you edit it while a scout is mid-crawl, and a silently changed file makes its
next answer wrong. Instead:

- a **remote** repo is shallow-cloned once into `~/.pi/scout/repos/<slug>-<digest>` and fetched again
  before a reopened session;
- a **local** path gets a `git clone --shared` (hardlinked objects, its own worktree and index).
- The digest covers the exact repo key and ref, so two repos or two refs that sanitize alike still get
  two trees. An existing tree is reused only when its origin is the source asked for, and a tree with
  a live conversation on it is never reset by another opener.

Every report ends with `repo`, `path`, `sha`, `thread` (the session file), and `turn`.

## package_repo

```text
package  zod
source   npm
version  3.22.4
repos
- https://github.com/colinhacks/zod  (repository, manifest, stated)  ref v3.22.4 (tag)
clone    https://github.com/colinhacks/zod ref=v3.22.4
```

**Sources.** `npm`, `jsr`, `crate` (crates.io), `pypi`, `dockerhub`. Each reads the field that registry
actually publishes:

| Source | Endpoint | Repo comes from |
|---|---|---|
| `npm` | `registry.npmjs.org/<name>` | the version manifest's `repository`, else the tarball |
| `jsr` | `jsr.io/@scope/name/meta.json`, then `/<version>/deno.json` | `githubRepository` in the version's `deno.json` |
| `crate` | `crates.io/api/v1/crates/<name>` | `crate.repository`, then `homepage` |
| `pypi` | `pypi.org/pypi/<name>/json` | `project_urls` Source/Code/Repository, then `home_page` |
| `dockerhub` | `hub.docker.com/v2/repositories/<owner>/<name>/` | a repo link in the description (Docker Hub has no repo field) |

**Version.** `version` picks the manifest to read and names the version in the result. When it is
absent the registry's latest is used; a version the registry does not have comes back as a warning.

**Ref.** Registries publish versions, not git tags, so a tag is a candidate (`v4.0.7`, `4.0.7`,
`zod@4.0.7`, `serde-v1.0.229`, …) that is only reported after `git ls-remote` confirms it. No match
means `ref none`, with the candidates listed so a caller can probe. A Docker tag never yields a git
ref, and says so.

**Clone target.** `clone` names the first repository the publisher *stated*. A name-search `guess` is
never offered as a target: a scout pointed at the wrong repo returns a confident report about the
wrong code. Guess-only results say `no stated repository` and omit the clone line.

Every candidate goes through a repo-root test, because publishers put docs sites, PyPI project pages,
and bug trackers in `repository` too: those cannot be cloned, so they are dropped, and the warning
names the URL. The URL must be https on a public host, so package metadata cannot point git at a
loopback, link-local, or internal name. Set `GITHUB_TOKEN` to raise the search rate limit.

## State and environment

| Path | Holds |
|---|---|
| `~/.pi/scout/repos/<slug>-<digest>` | scratch checkouts, one per repo and ref |
| `~/.pi/scout/sessions/<file>.jsonl` | scout conversations, reopened after eviction |

| Variable | Effect |
|---|---|
| `PI_SCOUT_HOME` | moves both directories (tests set it) |
| `PI_SCOUT_IDLE_MS` | idle window, default `600000` |
| `PI_SCOUT_TURN_MS` | one turn's ceiling, default `900000` |
| `GITHUB_TOKEN` / `GH_TOKEN` | authenticated GitHub search in `package_repo` |

## Files

| File | Role |
|---|---|
| `index.ts` | Wiring: registers both tools, one registry per process, passes the model and signal, disposes on shutdown. |
| `tools.ts` | Both tools as plain functions, plus paths, identity resolution, and the report header. |
| `scout-registry.ts` | Sessions: identity key, queue, idle clock, deadline, eviction, reopen. |
| `repo-id.ts` | Canonical repo identity from every accepted spelling. |
| `checkout.ts` | The scratch checkout: clone, refresh, origin, HEAD. |
| `registry.ts` | Package name to repo URLs. Pure parsers plus the two fetches. |
| `agent-session.ts` | The one place `createAgentSession` is called. |
| `DESIGN.md` | Why each of those choices was made. |

## Tests

```sh
cd ~/.pi/agent/extensions/repo-scout
npm test          # 101 tests: parsers, registry queue/identity/abort, checkouts, and a full pipeline run
npm run typecheck
```

The pipeline test runs a real `AgentSession` on a fake provider (`@earendil-works/pi-ai/providers/faux`),
so it proves open → continue → evict → reopen with no credentials and no network. `test/register.mjs`
resolves pi's package names for the test run, the way the extension loader does.

## Known limits

- **One repo per call.** Two repos are two calls (and two sessions); that is what keeps the cache whole.
- **Reports are text.** `package_repo`'s output is line-oriented, not structured content.
- **The registry lives in the pi process.** The key-to-session-file map is in memory, so a pi restart
  starts a new conversation and leaves the previous transcript on disk. Two processes do not share a
  conversation; each starts its own file.
- **A self-hosted forge under a path prefix** (`https://host/git/owner/name`) is read as `host/git/owner`,
  because only GitLab handles nested groups.
