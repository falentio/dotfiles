# Smoke suite

One run: the extension is copied into a temp agent dir's `extensions/`, a real `pi -p` process loads it
by discovery, and both tools are called from one codemode script against a `Bun.serve` stub.

Run it with `bun run test:smoke` from the extension directory. It needs a configured provider, because
the model has to choose to call the tools.

No `-e` flag. Discovery is the layout that loads the extension on a fresh machine, so the smoke proves
that path rather than the flag. Three things make it work:

- the copy carries `pi-schema`, the extension's one runtime import, or the load fails;
- `--tools +codemode` stays, because `codemode` ships as an extension and `--no-extensions` would remove
  the `tools` namespace too;
- both base URLs point at the stub. Leaving the fetch base at production means a 401 on the stub key,
  which marks the key dead for both endpoints and hangs the run on the model round trip.

`PI_CODING_AGENT_DIR` is a temp dir with no other extension, so discovery finds this one alone.
