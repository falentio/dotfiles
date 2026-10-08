---
name: control-ui
description: "Drive a browser, Electron, or web UI the way a user does, through the T3 preview tab. Use to reproduce a UI bug or verify a UI change on the real surface."
---

# Control UI

Drive the real UI. The tab's snapshot and screenshot are the evidence. A unit test is not a UI proof.

Every call is a `tools.mcp__t3_code__*` call in a codemode script and targets one **tab** by `tabId`. The drive ops are `preview_*`; the tab lifecycle is `preview_open`, `t3_preview_list`, and `t3_preview_close`.

## 1. Open the tab

Start the dev server with `devproc` (see the Long-running processes rule) and read its port from `devproc here`. Then open a background tab at that port:

```js
const tab = JSON.parse(await tools.mcp__t3_code__preview_open({
  open: false,              // background-only; no window to watch
  reuseExistingTab: false,  // fresh tab, isolated storage
  url: `http://localhost:${port}`,
})).tabId;
```

**Done when** `preview_status` reports `available: true` and `control.ownedByCaller: true`.

## 2. Snapshot for refs

```js
const snap = JSON.parse(
  (await tools.mcp__t3_code__preview_snapshot({ tabId: tab, includeImage: false }))
    .trim().split("\n").pop(),   // the reply is newline-delimited JSON; the last line is the snapshot
);
// refs live in snap.accessibilityTree:  textbox "Email" [ref=t3-...-e21]
```

**Done when** you hold a ref for the element you are about to act on.

## 3. Drive one flow

Target by `aria-ref=<ref>`, or by a role/text locator when you have no ref. Prefer a label over coordinates.

```js
await tools.mcp__t3_code__preview_type({
  tabId: tab, locator: "aria-ref=t3-a593b513-df-e21", text: "m@example.com", clear: true,
});
await tools.mcp__t3_code__preview_click({ tabId: tab, locator: "role=button[name='Sign in']" });
```

Refs expire on navigation, a dialog, or another snapshot. Take a fresh snapshot and use its refs in the same breath.

**Done when** the flow's steps are driven, one scenario at a time.

## 4. Assert the end state

Wait for the value, then read it. Name the exact string observed, not a summary.

```js
// wait for the value the flow should produce, then read it back exactly
await tools.mcp__t3_code__preview_wait_for({ tabId: tab, text: "Welcome back", timeoutMs: 8000 });
const seen = JSON.parse(await tools.mcp__t3_code__preview_evaluate({
  tabId: tab,
  expression: "document.body.innerText.includes('Welcome back')",
  returnByValue: true,
})).value;   // seen === true
```

**Done when** the end state is asserted against a named value, not a summary.

## 5. Reproduce-first for bugs

Drive the broken flow before touching code, save the failing screenshot, fix, then drive the same flow again and save the passing one. `save: true` writes the PNG and returns its path:

```js
const shot = JSON.parse(
  (await tools.mcp__t3_code__preview_snapshot({ tabId: tab, includeImage: false, save: true }))
    .trim().split("\n").pop(),
);
// shot.screenshotPath -> embed as ![<flow> <state>](shot.screenshotPath) so the reader sees it
//   alt names the flow and state (![picker guest-challenge]), so several shots read apart
```

**Done when** before and after screenshots exist at named paths.

## 6. Close and report

```js
await tools.mcp__t3_code__t3_preview_close({ tabId: tab });
```

Report the launch command, the flows driven, the screenshot paths, and the verdict.

**Done when** the tab is closed, the evidence files still exist at their paths, and the report names all four.

## Gotchas

- **The snapshot reply is newline-delimited JSON.** Parse the last line; the first is a thin `{"url": ...}` line.
- **`interactiveElements` is often empty.** The refs live in `accessibilityTree`, as text like `button "Sign in" [ref=...]`.
- **A stale ref errors.** `This element ref is stale` means a navigation, dialog, or newer snapshot replaced it — re-snapshot and retry.
- **`preview_select` is for a native `<select>`.** A custom dropdown is a click to open, then a click on the option.
- **Parallel subagents each need their own tab.** Open with `reuseExistingTab: false` and pass that `tabId` on every call.
- **A flow that only reads as motion:** `preview_recording_start` / `preview_recording_stop` returns a video path, same as a screenshot path.
