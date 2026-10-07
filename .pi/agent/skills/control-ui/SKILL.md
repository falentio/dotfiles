---
name: control-ui
description: "Drive a browser, Electron, or web UI the way a user does. Use to reproduce UI bugs, verify UI changes, and prove UI behavior with screenshots."
---

# Control UI

Drive the real UI. Screenshots plus interaction are the evidence. A unit test is not a UI proof.

## Steps

1. Find the launch command. Package scripts, dev server command, or Electron entry point. Start the app and wait for readiness: a log line, a port answering, or a window appearing. Record the URL or entry point.
2. Snapshot before acting. Use the browser snapshot tool to get refs. Prefer stable handles: ARIA labels, roles, data attributes, route paths. Never use coordinates or tab order when a label exists.
3. Drive one flow at a time. Click, type, and navigate via snapshot refs. Screenshot each state that matters for the verdict. Save screenshots to a named path and report the paths.
4. Assert the observable end state. Visible text, route, network response, or persisted value. Name the exact string or value observed, not a summary.
5. Reproduce-first for bugs. Drive the broken flow before touching code. Capture the failing screenshot. After the fix, drive the same flow again and capture the passing screenshot.
6. Clean up. Stop the server or close the page you started. Confirm evidence files still exist at their named paths after cleanup. Report launch command, flows driven, screenshots, and verdict.
