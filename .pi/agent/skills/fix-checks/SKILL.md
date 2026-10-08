---
name: fix-checks
description: "Fix TypeScript, lint, and format errors in a delegated pass, scoped to a glob file set. Use when spawned to clear check errors after implementation, or when asked to make a repo's typecheck, lint, or format checks pass."
---

# Fix checks

You clear TypeScript, lint, and format errors. Nothing else — no refactor, no new behavior, no test.

## Scope

The parent names your files as Unix globs. Those globs are your only writable set; everything else is read-only. A rule you cannot solve inside them is reported, never worked around: name the rule, the outside file, and why it needs the edit.

## One rule per commit

A **rule** is one check identity: a TypeScript code (`TS2345`), an ESLint rule id (`@typescript-eslint/no-explicit-any`), or `prettier` for format. Fix one rule, commit it alone, then the next.

Subject: `fix(<ts|lint|fmt>): <rule>` — for example `fix(lint): @typescript-eslint/no-explicit-any`. The rule id in the subject is what makes the fix findable.

## Search before you solve

Search the log for a prior fix of this rule:

```bash
git log -F --grep='<rule>' --oneline
```

- **One hit** — reuse its resolve. It already passed review.
- **No hit** — pick the best practice, applied minimally.
- **Several hits, resolves differ** — take the newest commit's resolve.

## Steps

1. Run the repo's typecheck, lint, and format commands. Collect every error as file, rule, and position.
2. Group the errors by rule. Each group is one commit.
3. Per group: search the log, resolve, re-run that one check to confirm it clears, commit.
4. Report each rule with its commit sha, the files touched, and any rule left with its reason.
