# Port spec: `@gamaraan/todos-tool` -> pi@1 extension

Port the OMP-style todo tool from `todos-port/source/` (pi@0.84.x) into a
pi@1.0.4 extension at `.pi/agent/extensions/todos/`. Keep only the tool-call
functionality. Drop the TUI view and the `/todo` command.

## Definition of done

1. `.pi/agent/extensions/todos/` loads in the installed `pi` (1.0.4) with no
   `Failed to load extension` diagnostic.
2. The `todo` tool is registered, active, and executable. `init/start/done/rm/
   drop/block/unblock/append/view` all behave as the source does.
3. `bun test` in the extension dir passes.
4. `tsc --noEmit` in the extension dir passes.
5. A live `pi` run calls the `todo` tool and its result is the durable record
   (branch replay returns the same phases).

## Scope: keep vs drop

The user dropped exactly two surfaces: the TUI view and the `/todo` command.
Everything that is neither stays, except dead code the drops orphan.

### Drop (delete the file)

- `src/render.ts` and `test/render.test.ts` — custom TUI rendering of the tool
  call/result.
- `src/command.ts` and `test/command.test.ts` — the `/todo` command controller.
- `src/markdown.ts` and `test/markdown.test.ts` — Markdown import/export, used
  only by `command.ts`.
- `src/notifications.ts` and `test/notifications.test.ts` — desktop-notify
  requests, a terminal/TUI feature.

### Drop (code inside a kept file)

- `index.ts`: the HUD widget (`updateHud`, `setWidget`, `HUD_WIDGET_KEY`), the
  `/todo` command, the `/todos-configure` wizard, `emitTodoNotifications`,
  `renderCall`/`renderResult`, and the `desktop-notify` EventBus emission.
- `config.ts`: `saveTodoConfig` and `readTodoConfig` are wizard-only. Drop
  them. Keep the config loading, defaults, flag names, env names, and
  `resolveTodoConfig`.
- `state.ts`: helpers used only by the dropped files. Verify each has no
  remaining caller before deleting: `selectCollapsedTodos`, `selectWithinCap`,
  `isActiveTodo`, `CollapsedTodoSelection`, `COLLAPSED_CLOSED_CONTEXT`,
  `COLLAPSED_ITEMS_CAP`, `pluralize`, `formatMoreItems`,
  `todoMatchesAnyDescription`, `normalizeForTodoMatch`,
  `TODO_DESCRIPTION_MIN_OVERLAP`, `nextActionableTask`, `validateTodoIdentities`,
  `applyOpsToPhases`, and `isClosedTodo` if the HUD removal orphans it. Delete
  only symbols with zero callers in the kept tree.

### Keep (ported, minimal edits)

- `src/types.ts` — `TodoStatus`, `TodoItem`, `TodoPhase`,
  `TodoCompletionTransition`, `TodoToolDetails`, `todoSchema`, `TodoParams`.
- `src/state.ts` — pure state ops, trimmed per above.
- `src/execute.ts` — `executeTodoOp`.
- `src/format.ts` — `formatSummary`.
- `src/persistence.ts` — `getLatestTodoPhasesFromEntries`,
  `USER_TODO_EDIT_CUSTOM_TYPE`. (The custom-entry branch stays: it is the
  branch-replay contract, harmless with no `/todo` writer.)
- `src/prompts.ts` — tool description + eager/nudge templates.
- `src/tracker.ts` — eager prelude, mid-run nudge, completion reminder,
  `pruneSupersededTrackerMessages`.
- `src/config.ts` — trimmed per above.
- `skills/todo-discipline/SKILL.md` — contributed via `resources_discover`.

### Keep (tests)

- `test/state.test.ts`, `test/persistence.test.ts`, `test/tracker.test.ts`,
  `test/config.test.ts` — trim cases that covered dropped symbols.
- `test/smoke.test.ts` — rewrite. Keep: tool registration and
  `executionMode`, `prepareArguments` op inference, branch-synced execution,
  eager prelude injection, reminders, `context` pruning, mid-run nudge. Drop
  every render, HUD, `/todo`, `/todos-configure`, and notification case.
- `test/helpers.ts` — drop `makeTestTheme` (no render tests). The context stub
  no longer needs a theme.

## Target layout

```
.pi/agent/extensions/todos/
  index.ts            extension entry (tool + tracker wiring)
  types.ts  state.ts  execute.ts  format.ts
  persistence.ts  prompts.ts  tracker.ts  config.ts
  skills/todo-discipline/SKILL.md
  test/*.test.ts  test/helpers.ts
  package.json        pi manifest + scripts
  tsconfig.json
  node_modules/       symlinks for bun test / tsc (see Toolchain)
```

The bundled skill path in `index.ts` is `new URL("./skills", import.meta.url)`
(index.ts sits at the extension root, not in `src/`). The source used
`../skills` because its index lived in `src/`.

## pi@1.0.4 API facts (proven by probe on this machine)

These resolve under the installed pi; do not re-derive them.

- `typebox` (`Type`, `type Static`), `typebox/value` (`Value.Check`,
  `Value.Errors`), and `StringEnum` from `@earendil-works/pi-ai` all resolve at
  runtime and typecheck. pi aliases `typebox` and `@earendil-works/pi-ai` to its
  bundled copies for extensions, so no local install is needed to run.
- `defineTool`, `ToolDefinition`, `ExtensionAPI`, `ExtensionContext`,
  `ExtensionCommandContext`, `ExtensionToolContext`, `AgentToolResult`,
  `AgentToolUpdateCallback`, `SessionEntry`, `CustomEntry`, `CONFIG_DIR_NAME`,
  `getAgentDir` are all exported from `@earendil-works/pi-coding-agent`.
- `AssistantMessage`, `TextContent` are exported from `@earendil-works/pi-ai`.
- Events present: `session_start`, `session_tree`, `session_compact`,
  `resources_discover`, `before_agent_start`, `tool_result`, `context`,
  `agent_end`, `agent_settled`.
- `pi.registerFlag`, `pi.getFlag`, `pi.getActiveTools`, `pi.setActiveTools`,
  `pi.sendMessage(msg, { triggerTurn } | { deliverAs: "steer" })`,
  `pi.appendEntry`, `pi.events.emit` all exist.
- `ToolResultEvent` carries `toolName` on each union member; read
  `event.toolName` and `event.isError`.
- `AssistantMessage.stopReason` is
  `"pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`.
  The tracker checks `"aborted"` and `"error"`.
- `ToolDefinition.execute` signature:
  `(toolCallId, params, signal, onUpdate, ctx: ExtensionToolContext)`.
- Tool registration is `pi.registerTool(defineTool({ ... }))`. There is no
  `renderShell` requirement.

## Toolchain

`bun test` and `tsc --noEmit` need a local `node_modules` because the packages
live inside pi's own install. Symlink them from the extension dir:

```sh
PI=/home/kevin/.vite-plus/packages/@earendil-works/pi-coding-agent/fb5a591f-7d9d-49a5-9091-269ee178f46f/lib/node_modules/@earendil-works/pi-coding-agent
NESTED=$PI/node_modules
mkdir -p node_modules/@earendil-works
ln -s $NESTED/typebox node_modules/typebox
ln -s $NESTED/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
ln -s $PI node_modules/@earendil-works/pi-coding-agent
```

Add `.gitignore` entries for `node_modules/` inside the extension dir so the
symlinks are not committed. `tsconfig.json` mirrors the source
(`strict`, `noUncheckedIndexedAccess`, `allowImportingTsExtensions`,
`noEmit`, `types: ["bun"]`). `@types/bun` is not installed; if `tsc` cannot
find `bun:test` types, add a `types` symlink or a local shim rather than an
install.

## Rules

- Port faithfully. Keep the source's comments only where they explain a
  non-obvious why (they mostly do, especially in `state.ts` and `tracker.ts`).
  Do not add narrating comments.
- No `any`, no inline imports. Guard array access per `noUncheckedIndexedAccess`.
- Errors are thrown: `execute` throws `outcome.summary` on `failed`.
- Every successful `todo` result carries
  `details: { op, phases, storage, completedTasks? }`. This is the durable
  record; keep the shape stable.
- Do not install packages. Use the symlinks above.
