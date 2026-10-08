# Long-running processes

A process that outlives the command that starts it — dev server, watcher, worker, tunnel — runs in a tmux **DEV session**, one per worktree. `devproc` owns the convention; reach for it rather than hand-rolling tmux.

## The DEV session name

```
DEV <repo> <branch> <port>
```

The name is the registry. `tmux ls` alone then says what runs, where, and on which port, and the identity survives across agents, shells, and machine restarts.

- `<repo>` — parent of the git common dir, so a worktree reports the repo it belongs to, not the worktree directory.
- `<branch>` — the checked-out branch, so a worktree's session is distinguishable from its siblings'.
- `<port>` — the TCP port the process listens on.

Dots become `_` in repo and branch: tmux rewrites `.` and `:` in session names on its own, and normalising up front keeps the name you wrote the name you target.

`devproc start` picks the port, so pass `{port}` where the command takes one and the name and the process agree on one number:

```bash
devproc start 'pnpm dev --host 0.0.0.0 --port {port}'
```

`devproc --help` lists the rest (list, here, read, stop, infer).

## Infer

Every direction of the question resolves:

- **This worktree** → its session: `devproc here`.
- **A live port** → repo, branch, worktree, pid: `devproc infer <port>`.
- **A session** → its worktree: `tmux display-message -p -t "=<name>:" '#{pane_current_path}'`.

## Targeting

Spell the target with `=` (exact session) and `:` (its pane): `-t "=DEV boardgame feat/x 3100"` for session commands, `-t "=DEV boardgame feat/x 3100:"` for pane commands. A bare name prefix-matches instead, and one DEV name is a prefix of another whenever their branch or port share a leading run (`3100` inside `31000`), so a bare name can silently hit the wrong session.

## Crash retention

`devproc start` sets `remain-on-exit`, so a process that dies leaves its pane — and its error — readable instead of vanishing with the session; `devproc read` still returns that output. Restart in place with `tmux respawn-pane -k -t "=<name>:" <command>`, or `devproc stop` to clear it.

## Cleanup

A DEV session outlives the shell that started it, so stopping the work means stopping the session. Clear every piece of residue it leaves: the session, a dead pane, an orphan, and its log.

- **The session.** `devproc stop` kills this worktree's session and frees its port; pass a name to target another. It resolves the default from `$PWD`, so run it in the worktree or name the session.
- **A dead pane.** `remain-on-exit` keeps a crashed process's pane alive (see Crash retention), and `devproc start` keeps refusing that worktree until you clear it. Read the error with `devproc read`, then `devproc stop`.
- **An orphan.** A session outlives its worktree: remove the worktree and the session keeps running against a path that no longer exists, out of reach of `devproc here`. Stop the session before you remove its worktree, and sweep any that slipped through:

  ```bash
  tmux ls -F '#{session_name}' | grep '^DEV ' | while IFS= read -r s; do
    p=$(tmux display-message -p -t "=$s:" '#{pane_start_path}')
    [ -d "$p" ] || devproc stop "$s"
  done
  ```

  `pane_start_path` survives a dead process where `pane_current_path` empties, so the same test catches a crashed session.
- **The log.** `devproc start` tees output to `/tmp/devproc-<slug>.log`, the session name with spaces and slashes as `_`; `devproc stop` leaves it behind. Remove it with the session.
