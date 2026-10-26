# repo-scout: design

Two pi tools replace the spawn/fork dance in the codebase-scout skill.

| Tool | Input | Output |
|---|---|---|
| `repo_scout` | `repo` (git URL, host/repo, or local path), `question`, optional `ref`, `model`, `thinkingLevel` | the scout-style report, plus the tree and commit that answered |
| `package_repo` | `package`, `source`, optional `version` | the git repos that serve it, with provenance, a verified ref, and the clone target |

Both are `exposure: "codemode"`, so the model reaches them from codemode scripts like every other tool.

## Decisions

### 1. One owner per repo: a scratch checkout, not the live worktree

A scout session is a pi `AgentSession` with a `cwd`. The cache the user wants is the provider prompt
cache, and that only holds if the session's context (including its working tree) does not shift under
it. A live worktree does shift: the main agent edits it between questions, and a file a scout already
read changes on disk, so its next answer is stale without saying so.

So every repo gets its own **scratch checkout** under `~/.pi/scout/repos/<slug>-<digest>`:

- `repo` given as a git URL or `host/owner/name` -> shallow clone into the scratch dir. A reopen
  fetches `origin HEAD` and resets to `FETCH_HEAD`.
- `repo` given as a local path -> a `git clone --shared` of it (cheap hardlink clone that still gives
  an independent worktree and index).
- a `ref` -> `git init`, `git remote add origin`, `git fetch origin <ref>`, `git checkout
  FETCH_HEAD`. `clone --branch` accepts a branch or a tag, never a commit.

The digest is `sha256(repo.key + '@' + ref)`. Names must be injective, not merely readable: `x-a/b`
and `x/a-b` flatten to one slug, and `release/1.0` and `release-1.0` flatten to one ref suffix, so
the hash is what keeps two repos or two refs from sharing a tree. An existing directory is reused only
when its `origin` resolves to the same source the request names; a directory from another repo is
discarded and cloned again, with a warning in the report.

### 2. One conversation per repo, ref, model, and thinking level

The identity is `repo.key` (every accepted spelling mapped to `github.com/owner/name`: lowercased,
trailing `/`, `.git`, query and fragment stripped, scp style accepted; a local path uses its `origin`
when it has one, else `realpath`).

A conversation is keyed by that identity **plus the ref, the model, and the thinking level**. An
`AgentSession` is bound to the model it opened with, so a thread that switches models must get a new
conversation; anything less answers on the old model until an eviction, then silently switches. The
key is computed from the request the caller sent, not recovered from a process-global map: the
registry takes one `ScoutRequest` and derives everything from it.

One registry lives per pi process, not per `cwd`/model/thinking partition. A partition keyed the
registry one way and the session file and checkout another, so two live sessions shared one transcript
and one tree, and the second open reset the tree under the first.

### 3. One question at a time, and a deadline

`run()` pushes onto the entry's `queue`, sets `busy`, and awaits its turn. A `pump()` loop runs one
question at a time and resolves the next waiter when it settles. FIFO, no starvation: further requests
wait, as asked. Different conversations run in parallel (separate sessions, separate checkouts).

Two things end a turn other than an answer:

- **The caller's abort signal.** It travels from the tool through the registry into the adapter, which
  calls `session.abort()`. A call whose signal is already aborted never opens a session.
- **A per-turn deadline** (`PI_SCOUT_TURN_MS`, default fifteen minutes). On expiry the adapter is asked
  to abort and the caller gets a timeout error. Without it, a wedged provider pinned that repo's FIFO
  for the life of the process.

Eviction settles the running waiter and rejects the queued ones. The idle sweep never evicts a busy
entry, so in practice that happens on shutdown or an explicit evict.

### 4. 10 minutes of inactivity, measured from the end of a run

`lastUsedAt` is set when a question settles (not when it starts, so a long crawl is not evicted
mid-run). A sweeper ticks every `idleMs / 3` and evicts sessions idle past `idleMs` (default 600_000,
env `PI_SCOUT_IDLE_MS`). Eviction disposes the session and drops the entry.

Prompt cache survives eviction because the conversation is **persisted**: the session manager writes
into `~/.pi/scout/sessions/` (a directory of its own, so pi's session listing stays clean). On the next
question the registry reopens that file with `SessionManager.open`, and the request is an append to the
same conversation: same cache prefix as before eviction.

**pi names the file, not us.** `SessionManager.create` ignores a desired filename and generates
`<timestamp>_<uuid>.jsonl`, so the registry asks the conversation what it actually wrote and remembers
that path. Remembering a guessed path instead starts a second file after every eviction, which loses
exactly the cache eviction exists to preserve. `scout-registry.test.ts` pins this against an adapter
that reports a different path than the one it was offered.

The key-to-file map is in memory, so it does not survive a process restart: a new pi process starts a
new conversation and leaves the old transcript on disk. That is the documented limit, not the design.

A reopened conversation **replays** its history, so it already holds the opening contract and the
earlier crawl: the adapter sends the bare question, and the report says `turn continued`. Only a
brand-new conversation gets the opening message, and only that turn is labelled `opened`. A turn that
fails after the opening message still counts as opened, so a retry says `continued`.

### 5. Model: the caller's current model, by default

The request names its model. `ctx.model` is the calling thread's model; `model: "provider/id"`
overrides it through the caller's `ModelRegistry`. The runtime comes from `ctx.modelRegistry`, so the
scout authenticates exactly as the caller does, with no second credential path. `thinkingLevel`
(default `medium`) travels the same way.

`updateModel` is not passed: a scout must not silently switch models. The model is part of the
conversation key, so a different model is a different conversation, never a re-pointed one.

### 6. The scout is a read-only agent

Tools: `read`, `grep`, `find`, `ls`. No bash, no edit, no write: a question is answered by reading.
`bash` would let a scout mutate its checkout and, worse, reach the network or the host.

Resources: only the scout skills are loaded (`codebase-scout`, `library-source`), through a
`DefaultResourceLoader` with `noExtensions`, `noThemes`, `noContextFiles`. Extension discovery is
off on purpose: loading this very extension inside its own scout session would recurse, and every
extension load costs startup time for nothing.

The tool itself writes a scratch checkout and a transcript, so `readOnlyHint` is false. The scout's
own toolset is what makes the reading read-only.

### 7. State the model needs is passed, not discovered

The agent loop the user is replacing forks the scout so it keeps the knowledge. Here the session file
keeps it, and the first message of a fresh session carries the checkout path and the report contract
(the exact `answer/findings/gaps/blockers/source` shape from `codebase-scout/SKILL.md`), so one tool
call yields a report the caller can read without asking again.

## The second tool: `package_repo`

`package_repo({ package, source?, version? })` resolves a package to the git repos that serve it, so
`repo_scout` can be pointed at one. Each source reads the field that registry publishes, then falls
back to a GitHub name search:

| Source | Endpoint | Repo comes from |
|---|---|---|
| `npm` | `registry.npmjs.org/<name>` | the version manifest's `repository`, else the tarball |
| `jsr` | `jsr.io/@scope/name/meta.json`, then `/<version>/deno.json` | `githubRepository` |
| `crate` | `crates.io/api/v1/crates/<name>` | `crate.repository`, then `homepage` |
| `pypi` | `pypi.org/pypi/<name>/json` | `project_urls` Source/Code/Repository, then `home_page` |
| `dockerhub` | `hub.docker.com/v2/repositories/<owner>/<name>/` | a repo link in the description |

`source` defaults to `npm`; an unknown one is an error naming the supported ones.

Output is data: `{ package, source, version, repos, warnings }`, rendered line by line. `kind` is
`repository` (browsable git) or `tarball` (provenance only). `via` names the field the URL came from,
`confidence` is `stated` or `guess`. Callers pass `url` and `ref` straight to `repo_scout`.

**Version.** `version` must be one plain path segment; anything with a slash or `..` is rejected
before a request is built, because it would otherwise choose the URL path (a jsr version could traverse
into another package). When the registry lists releases and the requested one is absent, the result
says so; the fields may describe another release.

### 8. A ref is verified, never assumed

Registries publish versions; git publishes tags; nothing maps one to the other. So `package_repo`
proposes the tag names a version is usually published under (`v4.0.7`, `4.0.7`, `zod@4.0.7`,
`serde-v1.0.229`) and then asks git: `ls-remote --tags --heads`. Only a ref git confirms is reported.
No match means `ref none` plus the candidates, because inventing a tag is worse than admitting the
mapping is unknown. A clone at a nonexistent ref fails loudly; a clone at a *similar* tag returns a
confident report about the wrong release.

`repo_scout({ ref })` puts the ref in the conversation key and in the checkout directory. Two refs are
two trees: sharing a directory would let a question about a release be answered by the default branch,
and sharing a conversation would mix the two in one cache prefix.

A ref is validated as a plain git ref name before it reaches an argv. `git fetch origin <ref>` parses a
leading `-` as an option, not a refspec, so `--upload-pack=<cmd>` would run a command on this host.

### 9. A guess is never a destination

Name search exists for packages whose registry carries no repository at all (`@std/path` publishes no
`githubRepository`; the search then returns unrelated repos named `path`). Reporting those URLs is
useful; offering one as the clone target is not. A scout pointed at the wrong repo answers
confidently about the wrong code, and nothing in the report says so.

So the rendered clone line takes only `confidence: stated` repositories, and a guess-only result
carries `no stated repository` as a warning. The guesses stay in `repos`, where a reader can verify one
and pass it to `repo_scout` explicitly.

### 10. Sources are a table, not a branch pile

Each registry publishes a different field: npm a manifest `repository`, PyPI `project_urls`, crates.io
`crate.repository`, JSR the version's `deno.json`, Docker Hub nothing but a free-text description. One
pure parser per source (`reposFromManifest`, `reposFromPypi`, `reposFromJsrDenoJson`,
`reposFromDockerhubHub`) keeps that knowledge testable with a fixture, and `discover()` is the only
place that knows which endpoint to call.

Every extracted URL goes through `isRepoRootUrl`. Publishers put docs sites, PyPI project pages, and
bug trackers in `repository` often enough that trusting the field hands a caller an uncloneable URL.
The URL must be https on a public host: an IP literal, `localhost`, `*.local`, and `*.internal` are
refused, because `git ls-remote` would otherwise become egress chosen by third-party metadata. Only
then does the forge test run: two segments on `github.com` is a repo, two segments on `hub.docker.com`
is a page. A `.git` suffix proves a git URL without bypassing either check.

## Boundaries

- Network boundaries live in `registry.ts` (`fetch`, `git ls-remote`) and `checkout.ts` (`git`),
  nowhere else; the parsing is pure and unit-tested with fixtures.
- Session lifetime and queueing live in `scout-registry.ts` only; nothing else touches `AgentSession`.
- `repo_scout` is read-only in effect but writes a scratch cache, so it is not declared read-only.

## Out of scope

- Writing to the caller's worktree, or editing the repo under study.
- Multi-repo questions in one call. Two calls, one per repo, stay cached separately.
- Sharing one conversation across two pi processes.
- Pruning `~/.pi/scout`: a disk policy needs a number that the user has not set.
