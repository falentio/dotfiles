---
name: deslop
description: "Clean slop out of a diff before commit. Use when a diff feels padded, before every commit via the Opening a PR playbook, or when asked to deslop."
---

# Deslop

Clean slop out of the code. Unslop cleans prose. No-comments handles comments via a separate reviewer. This skill handles the code itself.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. Read the diff. List every hunk under one of these buckets: narrating code, unsupported guard, dead compat path, unrelated edit.
2. Narrating code means the code restates what the next line already says. Delete it or fold it into the real logic.
3. Unsupported guard means a nil check, type check, retry, or fallback with no failing input, test, or error-tracker evidence behind it. Delete it. If the caller claims a real trigger, ask for the failing input and keep the guard only with proof.
4. Dead compat path means an old API, flag, or branch kept alive after its callers migrated. Migrate remaining callers then delete the old path in the same wave. No parallel old-and-new paths.
5. Unrelated edit means a drive-by fix, rename, or format outside the task scope. Revert it. Put it in its own change if it matters.
6. Apply the smallest deletions that clear every bucket. Do not reformat untouched lines. Do not rename for style.
7. Re-run the scoped checks. Typecheck plus the tests that cover the touched files. Report what you removed per bucket and the check outcome.
