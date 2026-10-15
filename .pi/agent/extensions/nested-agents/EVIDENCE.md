# On-the-fly injection: prototype evidence (real pi runs)

Every result below is from running the actual `pi` binary (v1.1.0) in print mode against a scratch
repo at /tmp/nested-demo, with a purpose-built extension. Not reasoned, observed.

Fixture: repo with .git, AGENTS.md at root, packages/, packages/api/, src/.
Extensions at /tmp/nested-demo/ext/. Commands and stderr logs preserved in /tmp/nested-demo/*.txt.

## Q1. Does the hook fire and can it inject? YES.

```
pi -p -e nested-agents.ts "Read packages/api/handler.ts ..."
[nested-agents] INJECTING /tmp/nested-demo/repo/AGENTS.md
```
The model's reply cited the injected rule. tool_result handlers can append to event.content and the
model sees it. The mechanic works with no core change.

## Q2. First attempt injected the WRONG file (repo root, not nearest).

The naive walk-up returned the first context file found anywhere up the chain, which was the repo
root. Fixed by walking up and stopping at the FIRST hit (nearest wins). Retest:
    [nested-agents] INJECT .../packages/api/AGENTS.md
Model reply: "...so it complies with the API package's AGENTS.md rule."
VERIFIED: nearest-file semantics work.

## Q3. Ancestor files are already in the system prompt, so injecting them duplicates.

Reading src/thing.ts (no nested file) caused injection of the repo-root AGENTS.md, which the normal
context mechanism ALREADY put in the system prompt. Fixed: inject only files STRICTLY BELOW cwd.
    [nested-agents] INJECT .../packages/api/AGENTS.md
    [nested-agents] NONE-BELOW-CWD .../src/thing.ts
VERIFIED: "strictly below cwd" is the correct boundary; otherwise every read of a shallow file
re-injects the root instructions.

## Q4. Two chain semantics, both work: nearest-only vs whole-chain-below-cwd.

With packages/AGENTS.md AND packages/api/AGENTS.md:
    nearest-only : INJECT packages/api/AGENTS.md
    chain        : INJECT packages/AGENTS.md + packages/api/AGENTS.md   (outermost first)
Both run clean. nearest-only is cheaper but silently omits the parent package's rules, which by the
documented "applies to its directory and below" semantics DO govern the file. Recommendation: chain,
outermost first, because dropping a governing file is the same failure the whole feature exists to fix.

## Q5. In-memory dedup is LOST on resume. Confirmed by real resume.

Turn 1 (new session): INJECT packages/AGENTS.md + packages/api/AGENTS.md
Turn 2 (--session-id demo1, same session, same file):
    INJECT packages/AGENTS.md + packages/api/AGENTS.md      <-- injected AGAIN
The extension's Set is process-local; a resumed session starts a fresh process.
VERIFIED: in-memory dedup is wrong. The instructions get re-injected on every resume.

## Q6. Dedup against the transcript via appendEntry fixes resume. Confirmed.

    Turn 1: session_start: 0 already injected; INJECT both
    Turn 2 (resume): session_start: 2 already injected; NONE-NEW
Transcript records: "customType":"nested-agents-injected","data":{"path":".../packages/AGENTS.md"}
VERIFIED: pi.appendEntry + reading the branch on session_start survives resume.

## Q7. Path-keyed dedup makes EDITED instructions permanently stale. Confirmed.

Turn 1: inject. Then append a new rule to packages/api/AGENTS.md. Turn 2 (resume):
    session_start: 2 already injected
    NONE-NEW /tmp/nested-demo/repo/packages/api/handler.ts
The model is never told the file changed. It keeps acting on the old text.
VERIFIED: dedup must be keyed on CONTENT HASH, not path.

## Q8. Content-hash dedup fixes staleness and still dedups. Confirmed over 4 turns.

    Turn 1 (fresh):      INJECT packages + packages/api
    Turn 2 (resume):     UNCHANGED both; NONE-NEW
    Turn 3 (file edited):INJECT packages/api            <-- only the changed file, re-sent
    Turn 4 (resume):     UNCHANGED both; NONE-NEW
VERIFIED: hash-keyed dedup re-injects on change and skips when unchanged, across resumes.

## Q9. Compaction hazard: NOT CONFIRMED BY RUN. Stated from source only.

My compaction run did not commit a compaction entry (session too short to trip the trigger; the
session file has no "type":"compaction"). So I could not observe this end to end. From reading
src/core/session-manager.ts:

- buildContextEntries() (line ~479) drops every entry before compaction.firstKeptEntryId:
      "if (foundFirstKept && !(entry.type === 'message' && entry.message.role === 'system'))
         contextEntries.push(entry)"
  So a marker custom entry older than firstKeptEntryId is EXCLUDED from the model view.
- getBranch() (line ~1469) returns ALL entries on the path, ignoring compaction.

My prototype reads getBranch(). After a compaction that cuts above the marker:
  - the marker is still in getBranch  -> dedup SKIPS
  - the injected content (which lived in a tool_result message) may be summarized away
  -> the model silently loses the instructions while the extension thinks it sent them.

MITIGATION to implement and test: read buildContextEntries() (the model view), not getBranch(), for
dedup state. That is strictly more correct. It does NOT fully solve it, because the injected text
rides in a tool_result message that compaction can summarize; a fully robust version would re-inject
after a session_compact event. Both are open, and both need a real compaction run to confirm.
Status: INFERRED from source, NOT RUN.

## Q10. Trigger set, settled by observation.

```
edit  (no prior read):  tool_result fired: read  -> INJECT
                        tool_result fired: edit  -> NONE-NEW
write (new file):       tool_result fired: write -> INJECT
                        tool_result fired: read  -> NONE-NEW
bash (cat a file):      tool_result fired: bash  -> (no path input, NO INJECT)
```

VERIFIED:
- `edit` internally performs a read first, so hooking `read` already covers edit. Hooking edit as
  well is harmless (dedup makes it a no-op) but unnecessary.
- `write` MUST be hooked: a brand-new file cannot have been read, so read alone misses it. Observed
  the write injection firing on a new file.
- `bash` fires but carries no `path` input, so a path-based hook cannot see `cat foo.ts`. This is a
  real coverage gap: reading through bash bypasses injection. Closing it needs bash-command parsing,
  which is out of scope and flagged as a limitation.

Final trigger set: read + write.

## Q11. Limitations, stated plainly.

1. bash-mediated reads bypass injection (Q10). No clean fix without parsing shell commands.
2. Only the first hit per directory is loaded (AGENTS.override.md wins over AGENTS.md, as in core).
3. A file read BEFORE its subtree context existed is not re-injected until content changes.
4. Compaction: reading buildContextEntries() is more correct than getBranch() (Q9) but does not fully
   solve it, since the injected block rides in a tool_result message compaction can summarize. A
   session_compact handler that re-injects would close it. NOT verified by a run.
5. No byte budget. Bounded in practice by "below cwd" plus one injection per file per revision, but a
   repo with hundreds of nested files and wide reads could still add up.

## Q12. BUG FOUND AND FIXED: edit injected nothing.

My earlier claim that "edit performs an internal read first" was FALSE. I had observed a run where a
read preceded the edit, but the read was the MODEL choosing to read, not the tool. Reading the source
settles it: edit.ts:186 calls `ops.readFile(absolutePath)` directly. It never issues a read tool call,
so no read tool_result fires.

Reproduced against the LIVE extension with only the edit tool available:

    pi -p -t edit "edit packages/api/handler.ts, replace return 1 with return 9"
      file after:   ...return 9...            (the edit happened)
      markers:      0                         (nothing injected)
    control, -t read,edit with an explicit read:
      markers:      2

FIX: add "edit" to TRIGGER_TOOLS.

## Q13. BUG FOUND AND FIXED: the file_path alias was ignored.

pi's own tool renderers read `args.file_path ?? args.path` (renderers/read.ts:36, write.ts:103,
edit.ts:84), because models sometimes emit the legacy `file_path` field. The extension read only
`input.path`, so a call carrying the alias resolved no path and injected nothing.

FIX: pathFromInput() reads `input.path ?? input.file_path`.

## Q14. Still NOT verified: compaction.

Forcing compaction needs context above (contextWindow - reserveTokens). I raised reserveTokens to
900000 in the demo repo's settings and it still did not commit a compaction entry in a short session,
so I have no end-to-end observation. What I have is the source at session-manager.ts:479-509, which
shows buildContextEntries() excludes entries before compaction.firstKeptEntryId. The extension reads
that function rather than getBranch() for exactly that reason. A session_compact handler that
re-injects would make it robust rather than merely correct-by-reading. Status: INFERRED, NOT RUN.

## Q15. Suite counts after the fixes.

    logic.test.ts + handler.test.ts   50 tests, 0 fail   (~0.2s, no model calls)
    smoke.test.ts                      5 tests, 0 fail   (~100s, real pi runs)

The handler test that previously ASSERTED the wrong behaviour ("edit does NOT inject") was inverted
and is now a regression test for the bug.

## Q16. Expanded PRUNE_DIRS: what was added, what was deliberately excluded.

Method: scanned 33742 tracked files across five local repos (dotfiles, cimi, market, pi, t3code
clone) and counted how many live under each candidate name. The count is the false-positive test: a
name with tracked files is source in a real repo, and the prune rule is a HARD STOP (a file inside a
pruned subtree gets NO context), so a false positive breaks an entire source tree.

Added, grouped by producer, 79 names total:

    vcs            .git .hg .svn
    dependencies   node_modules bower_components .pnpm-store .yarn .bun vendor Pods Carthage .bundle
    build          dist build out obj coverage .nyc_output
    rust           target
    haskell        dist-newstyle .stack-work
    elixir         _build deps cover .elixir_ls
    zig            zig-out .zig-cache
    python         __pycache__ .venv venv .eggs .tox .mypy_cache .pytest_cache .ruff_cache htmlcov
    jvm            .gradle build
    apple          DerivedData .swiftpm build
    dart           .dart_tool .pub-cache
    next           .next .vercel .turbo .swc
    nuxt           .nuxt .output .nitro .data
    sveltekit      .svelte-kit
    astro          .astro
    angular        .angular
    nx             .nx
    bundlers       .vite .parcel-cache .cache
    remix          .cache
    reactNative    .expo
    storybook      storybook-static
    umi            .umi .dumi
    docusaurus     .docusaurus
    fresh          _fresh
    solid          .vinxi
    ssg            _site .jekyll-cache
    serverless     .wrangler .netlify .firebase .serverless .sst .amplify .open-next .wxt
    otherFrameworks .qwik .stencil .redwood .blitz
    terraform      .terraform .terragrunt-cache

Go has NO entries: Go dependencies live in the module cache (~/go/pkg/mod), not in the repo, and the
repo-side store is `vendor`, which is already pruned.

EXCLUDED because the scan showed them as real tracked source:

    name        tracked files observed
    lib         701
    public      287
    assets      200
    static       17
    pkg          19
    bin           9
    docs       1051
    scripts     462
    examples   2382
    packages    (workspace source in most repos)
    www tmp out log logs src test tests

Also excluded: .storybook, .vitepress, .meteor, .claude, .pi, .github, .docusaurus is IN but
.storybook is OUT, because .storybook holds config and story source while .docusaurus is pure output.

## Q17. My own test suite caught a false positive I introduced.

I first included "packages" in the dependency group, reasoning that pnpm workspaces keep copies
there. The existing fixture uses packages/ as source, so 2 tests failed immediately:

    ✖ re-delivers only the changed file, not its unchanged sibling   0 !== 1
    ✖ (the read of packages/api/handler.ts injected nothing)

Removed. node_modules and vendor already cover the dependency-store concern. This is the hard-stop
semantics proving its own danger: one wrong name silently disabled the feature for the fixture's
entire source tree, exactly as it would in a real repo.

## Q18. Verified end to end against real pi.

Fixture: packages/api with AGENTS.md at the api root, plus .next/AGENTS.md, target/AGENTS.md, and
src/AGENTS.md.

    read packages/api/target/debug/gen.rs   (inside pruned "target")
      markers: 0                            correct, pruned
    read packages/api/src/file.ts           (not pruned)
      injected: packages/AGENTS.md, packages/api/AGENTS.md, packages/api/src/AGENTS.md

The second case shows the full chain resolving, including the new src/AGENTS.md, so the prune list
did not over-reach.

## Q19. Suite counts.

    logic.test.ts + handler.test.ts   93 tests, 0 fail   (~0.2s)
    smoke.test.ts                      5 tests, 0 fail   (~58s, real pi)

## Q20. Three duplicate hazards found and closed.

The requirement: never send the same AGENTS.md twice, including across a resume in a NEW process.

### Hazard 1: symlink alias (REPRODUCED)

Dedup keyed on the path string. The same file reachable two ways injected twice:

    packages/api/AGENTS.md  and  alias/AGENTS.md -> same realpath
    read packages/api/a.ts  -> injected /repo/packages/api/AGENTS.md
    read alias/b.ts         -> injected /repo/alias/AGENTS.md     <-- SAME FILE, SECOND TIME

FIX: canonicalIdentity() = realpathSync. Dedup keys on identity; the logical path is still what the
model sees in the block.

### Hazard 2: a new process starts with an empty map (REPRODUCED)

The delivered map is process-local, so any resume in a fresh process began empty. Rebuild was already
done on session_start, but with two defects: it MERGED into the existing map instead of replacing,
and it keyed on the path string.

FIX: rebuild REPLACES the map on every session_start, so no stale in-memory entry can survive and a
transcript that no longer carries a record cannot suppress a re-inject.

### Hazard 3: compaction drops the marker, keeps the content (REPRODUCED, then FIXED)

Markers are appended BEFORE the tool result they describe (observed in the transcript: marker
parent -> marker -> toolResult). A compaction cut between two markers of one batch keeps the
toolResult but drops one marker. Swept against pi's real buildContextEntries:

    cut at m2 -> kept: k m2 t1 a2 m3 t2 a3
    m1 (marker for A) kept: false
    t1 (content for A and B) kept: true
    -> A is still in context but its marker is gone -> A would be re-injected (DUPLICATE)

FIX: recover records from the injected BLOCK, not only the marker. The block is the record: if the
text is in context, the model has the instructions. collectDelivered() now reads both custom marker
entries and the project_instructions blocks inside toolResult messages.

## Q21. Adversarial sweep: every cut point is consistent.

compaction.test.ts imports pi's REAL buildContextEntries (resolved from the install, with a bounded
search fallback) and sweeps every legal firstKeptEntryId on a branch that has a marker plus a block:

    cut@a3  marker=false block=false recognised=false consistent
    cut@k1  marker=false block=false recognised=false consistent
    cut@t1  marker=false block=true  recognised=true  consistent
    cut@m1  marker=true  block=true  recognised=true  consistent
    cut@a2  marker=false block=false recognised=false consistent
    cut@a1  marker=false block=false recognised=false consistent
    cut@u1  marker=false block=false recognised=false consistent

"recognised" always equals "still in context". No cut produces a miss, so no cut can produce a
duplicate while the content is present, and every cut that removes the content re-arms it.

## Q22. Suite counts.

    logic.test.ts + handler.test.ts + compaction.test.ts   117 tests, 0 fail  (~0.4s)
    smoke.test.ts                                            7 tests, 0 fail  (~99s, real pi)

smoke.test.ts now includes: three separate pi processes on one session (only the first injects), and
a symlinked path read after the real path (one marker, not two).

## Q23. CORRECTION: the compaction hazard in Q20 was NOT reachable. I overclaimed.

In Q20 I reported 'Hazard 3: compaction drops the marker, keeps the content' and showed a sweep
where a cut at m2 kept the toolResult but dropped a marker. That sweep used an entry id as
firstKeptEntryId that pi's own cut-point finder can NEVER select. The hazard was an artifact of my
test, not a real condition.

The proof, from pi's source and from a live session:

1. isCutPointMessage (src/core/compaction/compaction.ts) accepts only user, assistant,
   bashExecution, custom, branchSummary, compactionSummary. NOT toolResult.
2. findValidCutPoints requires sessionEntryToContextMessages(entry).some(isCutPointMessage).
3. A plain 'custom' entry projects to ZERO context messages (verified by calling the real
   sessionEntryToContextMessages on a marker). So our marker can never be a cut point.
4. Therefore the entries between a marker and its toolResult contain NO legal cut point, so no
   legal cut can drop the marker while keeping the block.

Verified three ways:
    - projection of a live session: both markers show msgs=0, toolResult shows msgs=1
    - sweep over every LEGAL cut point of a live session: 0 cuts split marker from block
    - entries strictly between a marker and its toolResult: 0 legal cut points
    => UNREACHABLE: pi's own compaction can never drop a marker while keeping its block

I also forced a REAL compaction with an extension-supplied cut at the last marker (a cut pi itself
would not choose) via session_before_compact, which pi does NOT validate. It committed, and
session_compact fired. Resuming it then failed at the PROVIDER with 'tool calls and tool results do
not match' -- the cut splits a tool call from its result, which the provider rejects before the
extension's dedup is ever consulted. So even the unvalidated path cannot produce a silent
duplicate; it produces a hard error.

Consequence: the block-recovery code in collectDelivered is NOT load-bearing for compaction. It is
kept because it is strictly more correct (the block IS the record) and costs nothing, but the claim
that it fixes a reachable compaction duplicate was wrong. Q20 Hazard 3 is retracted.

## Q24. Hazard 4 FOUND AND FIXED: one batch could repeat an identity.

selectDeliveries deduped only against the delivered map, never against its own output. When a parent
and a child directory link to the SAME file, the chain has two entries with one identity, and both
were emitted in a single injection. Reproduced:

    a/AGENTS.md    -> /repo/shared.md
    a/b/AGENTS.md  -> /repo/shared.md
    chain: [ /a/AGENTS.md, /a/b/AGENTS.md ]
    fresh count: 2
    fresh ids:   [ /shared.md, /shared.md ]     <-- same file twice in ONE block

FIX: a per-batch 'claimed' set, so the batch dedupes against itself as well as against history.

## Q25. Hazard 5 CHECKED: parallel tool calls. Not reachable.

toolExecution defaults to 'parallel' (packages/agent/src/agent.ts:253), so two tool calls in one
assistant message run concurrently and both fire tool_result. If the handler awaited anything, the
two could interleave between reading and writing the delivered map. It does not: the tool_result
handler body contains no await, so it runs to completion without yielding. A concurrent
double-invocation probe confirmed one injection and one marker set. No fix needed; the atomicity is
the reason, and it is worth keeping in mind if the handler ever grows an await.

## Q26. Hazard 6 CHECKED: fork and session replacement. Covered.

session_start fires with reason 'fork' (agent-session-runtime.ts:305,326,345) as well as 'new' and
'resume', and the handler rebuilds from the transcript on every one of them. A fork copies history,
so the markers and blocks come with it and are recovered. No fix needed.

## Q27. Suite counts after this pass.

    logic.test.ts + handler.test.ts + compaction.test.ts   122 tests, 0 fail  (~0.5s)
    smoke.test.ts                                            8 tests, 0 fail  (~88s, real pi)

New coverage: one batch never repeats an identity (logic + handler + real pi), and the
unreachability of the marker/block split (compaction, pinned so a future pi change that widens the
cut-point rules would fail this test rather than silently reintroduce the hazard).
