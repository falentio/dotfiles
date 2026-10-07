# todos

An Oh My Pi (OMP)-style phased todo list as a pi extension. The agent plans
work with a `todo` tool and marks each task as it finishes.

Ported from `@gamaraan/todos-tool` (pi@0.84.x). This version targets pi@1.0.4
and keeps only the tool-call behavior: the TUI view and the `/todo` command
are not included.

## The `todo` tool

The agent calls `todo` with one operation:

| `op` | Fields | Effect |
| --- | --- | --- |
| `init` | `list: [{phase, items}]` or `items` | Create the list; replaces an existing one |
| `start` | `task` | Mark in progress |
| `done` | `task` or `phase` | Mark completed |
| `drop` | `task` or `phase` | Mark abandoned |
| `block` | `task` or `phase`, optional `reason` | Mark blocked on external input |
| `unblock` | `task` or `phase` | Return a blocked task to pending |
| `rm` | optional `task` or `phase` | Remove a task or phase; omit both to clear |
| `append` | `phase`, `items` | Add tasks; creates the phase if missing |
| `view` | | Read the list |

Tasks are referenced by their exact content, never by an id. A missing `op` is
inferred when the arguments are unambiguous, so `{list: [...]}` becomes an
`init`.

State lives in the tool result and in a session snapshot. Every successful
call returns `details.phases` and writes a `todo_snapshot` session entry; the
extension rebuilds the list from the newest of either on the session branch.
Branching and rewinding show the list correct for that point in history.

The tool is registered `model-only`, so the model calls it directly and a
`codemode` script cannot. A wrapped call would record only the outer `codemode`
result and the list would not survive a resume.

## Session behavior

The extension adds three nudges around the tool, each gated on config:

- An eager prelude on the first turn asks for a phased `init` before work.
- A mid-run nudge after 12 mutating tool results asks the agent to mark
  finished tasks done.
- A completion reminder fires on `agent_before_settle` when the agent stops
  with open tasks and is not waiting on an answer. It appends a hidden message
  and continues the turn once, up to the reminder budget.

A `todo-discipline` skill at `<agent dir>/skills/todo-discipline` tells the
model to plan before working and to mark each task done as it finishes. It is
not part of this extension; it is discovered like any other agent skill.

## Config

Read from `<agent dir>/todo.json`, optionally overridden per trusted project
at `<cwd>/.pi/todo.json`.

```json
{ "enabled": true, "reminders": true, "remindersMax": 3, "eager": "default" }
```

`eager` is `default` (no prelude), `preferred` (a soft reminder), or `always`
(a MUST-call reminder). CLI flags `--todo-enabled`, `--todo-reminders`,
`--todo-reminders-max`, and `--todo-eager`, and the matching `PI_TODO_*`
environment variables, override the JSON. A global `enabled: false` is a floor
that project config cannot raise.

## Develop

pi provides `typebox`, `typebox/value`, and the `@earendil-works` packages at
runtime, so the extension runs with no install. For `bun test` and `tsc`, link
them into a local `node_modules`. `tsc` also needs Bun's type declarations
because `tsconfig.json` sets `"types": ["bun"]`:

```sh
PI=/home/kevin/.vite-plus/packages/@earendil-works/pi-coding-agent/fb5a591f-7d9d-49a5-9091-269ee178f46f/lib/node_modules/@earendil-works/pi-coding-agent
NESTED=$PI/node_modules
mkdir -p node_modules/@earendil-works node_modules/@types
ln -s $NESTED/typebox node_modules/typebox
ln -s $NESTED/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
ln -s $PI node_modules/@earendil-works/pi-coding-agent
ln -s /path/to/@types/bun node_modules/@types/bun
```

Replace the last path with a local `@types/bun` (Bun's own install ships one
under its `node_modules/@types/bun`).

Then run the checks:

```sh
bun test          # 118 tests
tsc --noEmit
```

`.pi/agent/todos-port/verify.mjs` runs those plus a live pi boot, and checks
that the dropped surfaces stay gone. Run it from the repo root with
`node .pi/agent/todos-port/verify.mjs`.
