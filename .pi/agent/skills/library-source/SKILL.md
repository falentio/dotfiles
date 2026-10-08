---
name: library-source
description: "Read a dependency's real source by shallow-cloning it to ~/source. Use when the answer lives in a library's code rather than its docs, when grep of node_modules or build output is the wrong surface, or when asked to clone a library at a version."
---

# Library source

When the answer is in a dependency's source, read the source — not `node_modules`, not a bundle, not a build artifact. Those are transformed, deduped, or minified; the source is the truth.

## Delegate the clone

Do not clone in the parent context. Delegate it: the search ceremony stays in the child, the parent keeps the path.

Pass the child three things and nothing else:

- the registry (`npm`, `pypi`, `crates`, `go`)
- the library name
- the version

One token: `npm zod@4.0.7`, `pypi requests@2.32.3`, `crates serde@1.0.200`.

## The child's steps

1. Resolve the source repo and its ref for that version.
   - `npm view <name>@<version> repository.url gitHead` → repo URL, commit SHA.
   - `curl https://pypi.org/pypi/<name>/<version>/json` → `info.project_urls.Source`.
   - `curl https://crates.io/api/v1/crates/<name>/<version>` → `crate.repository`.
   - The ref is the tag for the version — `v<version>`, else `<version>` — or the `gitHead` SHA when no tag matches.
2. Build the path. Normalise the repo URL (drop scheme, `.git`, and the `git@host:` prefix) to `host/path`, then encode: `-` → `--` first, then `/` → `-`; append `@<ref>`.

   ```bash
   base=$(printf '%s' "$url" | sed -E 's#^git\+##; s#^[a-z]+://##; s#^git@##; s#:#/#; s#\.git$##')
   slug=$(printf '%s@%s' "$base" "$ref" | sed -e 's/-/--/g' -e 's#/#-#g')
   ```

   `https://github.com/colinhacks/zod` at `v4.0.7` → `github.com-colinhacks-zod@v4.0.7`. Doubling the dashes first is what makes the encoding reversible: a real `-` becomes `--`, so a lone `-` can only be a path separator.
3. Shallow-clone to `~/source`:

   ```bash
   mkdir -p ~/source
   git clone --depth 1 --branch "$ref" "$url" "$HOME/source/$slug"
   ```

   Reuse the checkout when `~/source/$slug` already exists.
4. Report the path. The parent reads the source from there.
