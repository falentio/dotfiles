# bandar-metadata

Sets two headers on every request to the `bandar` provider that reaches the
provider header hook: `x-bandar-project-url` names the project the request came
from, and `x-bandar-session-id` names the pi session that sent it. A request to
any other provider carries neither header.

bandar is a gateway that sits in front of the model providers. It charges a
request to the project in `x-bandar-project-url`, keeps the origin and path of
that value, and drops any value that is not an absolute `http` or `https` URL. A
request without the header lands in bandar's unattributed usage. The session id
names the pi session, so the gateway can group every request one conversation
sends under one id. bandar already groups usage by `x-bandar-session-id`: its
gateway reads the header and stores the value with each request it records. This
extension is the sender half.

## The project url

The `x-bandar-project-url` value is the git remote of the working directory,
rewritten into a URL bandar accepts:

| Remote | Header |
| --- | --- |
| `https://github.com/o/r.git` | `https://github.com/o/r` |
| `http://host/o/r/` | `http://host/o/r` |
| `git@github.com:o/r.git` | `https://github.com/o/r` |
| `ssh://git@github.com/o/r.git` | `https://github.com/o/r` |
| `git://host/o/r.git` | `https://host/o/r` |
| `git+ssh://git@host/o/r.git` | `https://host/o/r` |
| `ssh://git@host:2222/o/r.git` | `https://host/o/r` |
| `https://host:8443/o/r.git` | `https://host:8443/o/r` |
| `http://host:8080/o/r` | `http://host:8080/o/r` |

The rewrite strips a `git+` prefix, drops user info, and keeps the port when
the remote is already `http` or `https`. It keeps `http` as `http`, moves every
other scheme to `https`, and removes a trailing `.git` and trailing slashes. An
ssh remote needs that rewrite because bandar accepts only `http` and `https`
values, and an ssh port belongs to ssh, not to the origin bandar keeps.

`origin` wins. Without a parseable `origin`, the first remote that parses is
used. A local path, a `file://` remote, and a remote with no path do not parse.
A Windows path does not parse, whether it uses backslashes or a drive letter
with forward slashes.

## The session id

The `x-bandar-session-id` value is the id pi reports for the session. One
conversation reuses one session, so every request in it carries the same value.
The id is always present, and pi validates it at its CLI boundary, so the handler
sends it as it comes. bandar keeps a value of 1 to 128 printable ASCII characters
and drops any other value as unattributed. The ids pi generates are
36-character UUIDs, so they fit. No cache is needed, because pi already holds the
id.

## How it runs

pi fires `before_provider_headers` after it assembles the request headers and
before the provider call. The handler returns early unless the request goes to a
provider in `ATTRIBUTION_PROVIDERS` (`config.ts`), which lists `bandar`.

For a bandar request, the handler sets `x-bandar-session-id` from
`ctx.sessionManager.getSessionId()`. It then sets `x-bandar-project-url` from the
git remote of `ctx.cwd`: it runs `git -C <cwd> config --local --get-regexp
'^remote\.'` once per working directory and caches the result for the session.
The wire names live in `headers.ts`. The extension registers no command, tool, or
status line.

## A compaction summary carries no header

pi builds the summarization request with its own auth headers and never fires
`before_provider_headers`, so a compaction summary carries neither header.
bandar records those tokens as unattributed and sees no session id for that
request. An extension cannot add a header to that request on pi 1.4.0.

## No remote, no project url

When git is missing, the directory is not a repository, or no remote parses, the
request carries no project url. It still carries the session id, which does not
depend on the repository.

## Develop

pi provides the `@earendil-works` packages at runtime, so the extension runs
with no install. For `bun test` and `tsc`, the shared linker symlinks the
current pi install into `node_modules`. Both scripts run it first:

```sh
bun run test        # links pi, then the suite
bun run typecheck
```

The smoke test drives the real `pi` CLI against a local OpenAI-compatible
server and asserts both headers on the wire.
