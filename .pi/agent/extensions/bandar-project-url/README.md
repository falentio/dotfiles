# bandar-project-url

Sets `x-bandar-project-url` on every model request, so bandar can charge the
request to the project it came from.

bandar is a gateway that sits in front of the model providers. It reads that
header, keeps the origin and path of the value, and drops any value that is not
an absolute `http` or `https` URL. A request without the header lands in
bandar's unattributed usage.

## What is sent

The header value is the git remote of the working directory, rewritten into a
URL bandar accepts:

| Remote | Header |
| --- | --- |
| `https://github.com/o/r.git` | `https://github.com/o/r` |
| `http://host/o/r/` | `http://host/o/r` |
| `git@github.com:o/r.git` | `https://github.com/o/r` |
| `ssh://git@github.com/o/r.git` | `https://github.com/o/r` |
| `git://host/o/r.git` | `https://host/o/r` |
| `ssh://git@host:2222/o/r.git` | `https://host/o/r` |

The rewrite drops user info and the port, keeps `http` as `http`, moves every
other scheme to `https`, and removes a trailing `.git` and trailing slashes.
An ssh remote needs that rewrite because bandar accepts only `http` and
`https` values.

`origin` wins. Without a parseable `origin`, the first remote that parses is
used. A local path, a `file://` remote, and a remote with no path do not parse.

## How it runs

pi fires `before_provider_headers` after it assembles the request headers and
before the provider call. It runs `git -C <cwd> config --local --get-regexp
'^remote\.'` once per working directory, caches the result for the session, and
assigns the header in place. The extension registers no command, tool, or
status line.

## No remote, no header

When git is missing, the directory is not a repository, or no remote parses,
the handler leaves the request alone. bandar then records the usage without a
project.

## Develop

pi provides the `@earendil-works` packages at runtime, so the extension runs
with no install. For `bun test` and `tsc`, the shared linker symlinks the
current pi install into `node_modules`. Both scripts run it first:

```sh
bun run test        # links pi, then the suite
bun run typecheck
```

The smoke test drives the real `pi` CLI against a local OpenAI-compatible
server and asserts the header on the wire.
