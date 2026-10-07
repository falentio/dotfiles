---
name: control-cli
description: "Drive a CLI or TUI the way a user does. Use to reproduce CLI bugs, verify CLI changes, and prove terminal behavior with real command output."
---

# Control CLI

Drive the real binary. Captured command output is the evidence. A unit test alone is not a CLI proof.

## Steps

1. Build once. Install deps or compile the binary. Record the exact build command used.
2. Isolate each drive. Short-lived commands run directly with explicit args and env. Interactive TUIs run in their own tmux session or PTY so drives never share state. Never double-drive a shared session.
3. Drive one scenario at a time. Run the exact command a user would run. Capture stdout, stderr, and exit code in full. Save long output to a file and report the path.
4. Assert the observable end state. Exact output bytes, exit code, or resulting file and data change. Quote the real output, not a paraphrase.
5. Reproduce-first for bugs. Run the broken command before touching code. Save the failing output. After the fix, rebuild and rerun the same command. Show before and after output.
6. Clean up. Kill tmux sessions you started. Remove temp dirs you created. Confirm saved evidence still exists after cleanup. Report build command, commands run, output paths, and verdict.
