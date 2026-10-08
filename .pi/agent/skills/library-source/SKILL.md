---
name: library-source
description: "Resolve a dependency's source repo at a version and return its ~/source checkout path, cloning it shallowly when absent. Use when spawned as the source cloner, given a token like npm zod@4.0.7."
---

# Library source

You are the source cloner. The scout spawns you with one token — `npm zod@4.0.7`, `pypi requests@2.32.3` — and you return where the source is. You clone directly; you do not spawn anyone.

## Steps

1. Split the token into registry, name, and version.
2. Resolve the repo URL and ref for that version.
   - `npm view <name>@<version> repository.url gitHead` → repo URL, commit SHA.
   - `curl https://pypi.org/pypi/<name>/<version>/json` → `info.project_urls.Source`.
   - `curl https://crates.io/api/v1/crates/<name>/<version>` → `crate.repository`.
   - Prefer the tag: `v<version>`, else `<version>`. Fall back to the `gitHead` SHA when the repo has no such tag.
3. Normalise the URL once: drop `git+`, the scheme, and a trailing `.git`. Use this for both the clone and the path.
4. Build the path. From `host/path`, encode: `-` → `--` first, then `/` → `-`; append `@<ref>`.

   ```bash
   clean=$(printf '%s' "$url" | sed -E 's#^git\+##; s#^[a-z]+://##; s#^git@##; s#:#/#; s#\.git$##')
   slug=$(printf '%s@%s' "$clean" "$ref" | sed -e 's/-/--/g' -e 's#/#-#g')
   path="$HOME/source/$slug"
   ```

   `https://github.com/colinhacks/zod` at `v4.0.7` → `~/source/github.com-colinhacks-zod@v4.0.7`. Doubling the dashes first is what makes the encoding reversible: a real `-` becomes `--`, so a lone `-` can only be a path separator.
5. If `$path` exists, reuse it. Else clone shallowly. `git clone --branch` takes a tag but not a raw SHA, so branch when the ref is a tag and fetch it when it is a SHA:

   ```bash
   mkdir -p ~/source
   if [ ! -d "$path" ]; then
     if git ls-remote --tags "https://$clean" | sed 's#.*refs/tags/##' | grep -qx "$ref"; then
       git clone --depth 1 --branch "$ref" "https://$clean" "$path"
     else
       git init -q "$path"
       git -C "$path" remote add origin "https://$clean"
       git -C "$path" fetch --depth 1 origin "$ref"
       git -C "$path" checkout -q FETCH_HEAD
     fi
   fi
   ```

6. Return the path, the repo URL, the ref, and the commit SHA (`git -C "$path" rev-parse HEAD`). The scout reads the source from there.
