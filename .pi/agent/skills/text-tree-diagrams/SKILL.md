---
name: text-tree-diagrams
description: Render call stacks, flow diagrams, sequence diagrams, file trees, and other hierarchical structures as clear ASCII-style text trees. Use this skill whenever the user asks for a diagram, how the code works, execution path, hierarchy, or asks to improve an existing tree. Apply these conventions to every diagram response
---

## Call-stack Tree Diagrams

Use this format when the main information is hierarchical: call stacks, flow diagrams, sequence-like flows, file trees, module trees, and execution plans. Make the tree the primary artifact and keep surrounding prose short.

During planning, explain procedure, endpoint, or method structure with a tree instead of implementation code unless the user requests code.

### Tree Structure

- Put the root or entry point on the first line.
- Put one node on each line.
- Indent each child by four spaces relative to its parent. Nodes at the same depth must start in the same column.
- Use `├──` for a sibling followed by another sibling, and `└──` for the final sibling.
- Carry `│` through an ancestor that has later siblings. Use spaces when that ancestor is the final sibling.
- Order calls or steps from top to bottom. Use nesting to show containment or call depth.
- Keep lifecycle steps, long-running loops, and per-item or per-request work visibly separate when they repeat differently.
- Keep one tree uninterrupted. Use blank lines only between separate trees or before footnotes.

### Node Numbering

Number every node in every tree. Use a compact hierarchical ID so readers can refer to any node without counting lines.

- Put the ID after the node label in square brackets.
- Use one token for each tree level, including the root.
- Start the root at `[1]`. Treat the root as depth 0.
- Use numbers at even depths and lowercase letters at odd depths. Map `a` to the first child, `b` to the second child, and so on.
- Continue alphabetic positions after `z` with `aa`, `ab`, and so on.
- Build each ID from the root to the node. Do not restart it at a branch.
- Number every visible node, including branch labels, loop labels, and leaves.
- Refer to a node by its complete ID.
- Use the node ID as the footnote marker. Do not add a separate marker.

```text
request() [1]
├── parseHeaders() [1a]
├── authenticate() [1b]
│   ├── if token valid: [1b1]
│   │   └── attachUser() [1b1a]
│   └── otherwise: [1b2]
│       └── throw 401 [1b2a]
└── handler.process() [1c]
```

### Inline Annotations

- Put a short reason or qualifier after a node with `←`. Keep it to eight words or fewer when possible.
- Use the node ID as the footnote marker when an explanation would make the tree hard to scan.
- Keep annotations on the same line as their node. Put longer context below the tree in a **Footnotes** table.

```text
loadConfig(".env") [1] ← read environment variables
authenticate() [2] ← validate session or JWT
throw 401 [3] ← stop the request
```

```text
connectDB(url) [1]
```

| Marker | Context |
| --- | --- |
| [1] | A shared pool avoids a connection handshake per request. |

Footnotes are optional when every node is self-explanatory.

### Control Flow

Label repetition explicitly and indent the repeated work beneath the loop.

```text
listen(port) [1]
└── for each request: [1a]
    ├── parseHeaders() [1a1]
    └── process(request) [1a2]
```

For bounded retries or numbered iterations, make the attempts siblings of the retry node:

```text
connectDB(url) [1]
└── retry loop ×3: [1a]
    ├── attempt 1: openSocket() [1a1] ✗ timeout
    ├── attempt 2: openSocket() [1a2] ✗ timeout
    └── attempt 3: openSocket() [1a3] ✓ connected
```

Represent conditional branches as children of the decision or routing node. Use `otherwise` for the final branch:

```text
routeMatch(url) [1]
├── if /api/*: [1a]
│   └── handleAPI() [1a1]
├── if /static/*: [1b]
│   └── serveFile() [1b1]
└── otherwise: [1c]
    └── serveIndex() [1c1]
```

Nested conditionals follow the same indentation rule:

```text
authenticate() [1]
├── if token valid: [1a]
│   └── attachUser() [1a1]
└── otherwise: [1b]
    └── throw 401 [1b1]
```

### Status Markers

- Use `✓` for success, optionally followed by the result: `✓ connected`.
- Use `✗` for failure, followed by the reason when useful: `✗ deadlock`.
- Keep the marker on the same line as the operation it describes.

## Example

### Server Startup and Request Handling

```text
main() [1]
├── init() [1a] ← entry point; runs first
│   ├── loadConfig(".env") [1a1] ← read environment
│   ├── connectDB(url) [1a2]
│   │   └── retry loop ×3 [1a2a]
│   │       ├── attempt 1: openSocket() [1a2a1] ✗ timeout
│   │       ├── attempt 2: openSocket() [1a2a2] ✗ timeout
│   │       └── attempt 3: openSocket() [1a2a3] ✓ connected
│   └── registerPlugins() [1a3]
│       └── for each plugin in [auth, cache, cors]: [1a3a]
│           └── plugin.setup() [1a3a1] ← run setup hook
├── listen(port) [1b] ← blocking loop
│   └── for each request: [1b1]
│       ├── parseHeaders() [1b1a] ← method, path, cookies
│       ├── routeMatch(url) [1b1b]
│       │   ├── if /api/*: [1b1b1]
│       │   │   └── handleAPI() [1b1b1a]
│       │   ├── if /static/*: [1b1b2]
│       │   │   └── serveFile() [1b1b2a]
│       │   └── otherwise: [1b1b3]
│       │       └── serveIndex() [1b1b3a]
│       ├── authenticate() [1b1c] ← validate session or JWT
│       │   ├── if token valid: [1b1c1]
│       │   │   └── attachUser() [1b1c1a]
│       │   └── otherwise: [1b1c2]
│       │       └── throw 401 [1b1c2a] ← stop request
│       └── handler.process() [1b1d]
│           ├── validateBody() [1b1d1] ← required fields and types
│           ├── if businessRule(X): [1b1d2]
│           │   └── applyDiscount() [1b1d2a]
│           └── saveToDb() [1b1d3]
│               └── retry loop [1b1d3a]
│                   ├── attempt 1: insert() [1b1d3a1] ✗ deadlock
│                   └── attempt 2: insert() [1b1d3a2] ✓ success
└── cleanup() [1c]
    ├── disconnectDB() [1c1]
    └── flushLogs() [1c2]
```

**Footnotes**

| Marker | Context |
| --- | --- |
| [1a2] | A shared pool avoids opening a new database connection per request. |
| [1b1b] | Prefix routing selects the API, static-file, or SPA pipeline. |
| [1b1d2] | The promotion rule is gated by the current campaign and user segment. |
| [1b1d3a] | The bounded retry absorbs transient database deadlocks; the final failure propagates. |
| [1c] | Graceful shutdown stops intake, drains work, flushes logs, and closes sockets. |
