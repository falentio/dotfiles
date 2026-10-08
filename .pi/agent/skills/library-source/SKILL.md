---
name: library-source
description: "Resolve a dependency's source repo at a version and return its ~/source checkout path, cloning it shallowly when absent. Use when spawned as the source cloner, given a token like npm zod@4.0.7."
---

# Library source

You are the source cloner. The scout spawns you with one token — `npm zod@4.0.7`, `pypi requests@2.32.3` — and you return where the source is. You clone directly; you do not spawn anyone.

## Flow

```text
C: checkout source [1]
├── split token → registry, name, version [1a]
├── resolve repo url + ref  ← prefer tag v<version>, else <version>, else gitHead sha [1b]
│   ├── npm:  npm view <name>@<version> repository.url gitHead [1b1]
│   ├── pypi: curl pypi.org/pypi/<name>/<version>/json → info.project_urls.Source [1b2]
│   └── crates: curl crates.io/api/v1/crates/<name>/<version> → crate.repository [1b3]
├── normalise url → clean  ← drop git+, scheme, .git [1c]
├── build path  ← ~/source/<slug> [1d]
├── path exists? [1e]
│   ├── yes: reuse [1e1]
│   └── no: ref is a tag? [1e2]
│       ├── yes: git clone --depth 1 --branch <ref> [1e2a]
│       └── no: init, fetch --depth 1 <sha>, checkout FETCH_HEAD [1e2b]
└── return path, repo, ref, sha  ← git rev-parse HEAD [1f]
```

## Build the path

From `host/path`, encode: `-` → `--` first, then `/` → `-`; append `@<ref>`.

```bash
clean=$(printf '%s' "$url" | sed -E 's#^git\+##; s#^[a-z]+://##; s#^git@##; s#:#/#; s#\.git$##')
slug=$(printf '%s@%s' "$clean" "$ref" | sed -e 's/-/--/g' -e 's#/#-#g')
path="$HOME/source/$slug"
```

`https://github.com/colinhacks/zod` at `v4.0.7` → `~/source/github.com-colinhacks-zod@v4.0.7`. Doubling the dashes first is what makes the encoding reversible: a real `-` becomes `--`, so a lone `-` can only be a path separator.

## Clone

`git clone --branch` takes a tag but not a raw SHA, so branch when the ref is a tag and fetch it when it is a SHA:

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
