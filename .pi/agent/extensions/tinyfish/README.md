# tinyfish

Two codemode tools, `tools.tinyfish_search` and `tools.tinyfish_fetch_content`, call the TinyFish
REST API from this machine. The MCP server is gone. The tools hold N API keys in
`~/.tinyfish/accounts.json`, hand each request an account under a lease, and read the
account's cooldown off how the request came back.

Read it as three parties:

- the agent, which calls the tools from a codemode script and never sees a key, an account, or a
  cooldown;
- the handler in `./index.ts`, which makes one client call and never touches the pool;
- the operator, who adds keys and reads the failure text.

## The agent view

The names, the parameters, and the envelope are the MCP's, so a prompt written before the move
keeps calling. Both tools stay reachable only from codemode scripts, because
`.pi/agent/settings.json` sets `codemode.mode: "only"`. A rate limit that used to throw now costs
wall-clock time instead, so a burst keeps working.

```js
const found = await tools.tinyfish_search({ query: "python pdf invoice parser", page: 0 });
const pages = await tools.tinyfish_fetch_content({
  urls: found.results.slice(0, 3).map((r) => r.url),
  format: "markdown",
  links: false,
  image_links: false,
  page_metadata: true,
});
return { sources: pages.results.map((r) => [r.final_url, r.title]), failed: pages.errors };
```

Both return the MCP envelope: the body as text in `content`, for the model, and the body itself in
`structuredContent`, which is what a codemode script receives. So `found.results` is a property read,
and no `JSON.parse` belongs in a script. The output schema is one open object, so a field the API adds
still arrives. A per-URL fetch failure lands in `errors` and does not throw; a request-level failure
throws.

| Wire | What the agent sees |
| --- | --- |
| 200 | the body |
| 429 | nothing; the call rotated or waited |
| 401 | nothing; that key is retired for the session |
| 402 / 403 | a throw only when every key is spent, naming `wallet_url` |
| 400 / 422 | a throw, no rotation |
| 5xx, unclassifiable status, socket | a throw after three backoff turns |

A cooling pool is waited out, up to five minutes, and then throws naming the endpoint and its limit.

## The handler view

One call, one wrap. Everything about the pool is under the client.

```ts
// ./index.ts, one of two, same shape
async execute(_id, params, signal) {
  return envelope(await deps().client.search(params, signal));
}
```

Under that, one attempt is a lease: acquire, `send`, release with the grade. `callPool` owns the retry
loop, so the transport is the wire call and nothing else. `send` is the only reader of
`lease.account.key`; it writes `X-API-Key`, adds `Content-Type: application/json` on the fetch POST,
and nothing else ever holds a raw key.

`callPool` releases on both exits and rotates on `rate-limited`, `dead-key`, `spent`, and `transient`
(the last for three turns, with backoff), before surfacing the error. A `transient` release also
pushes that key's pacing stamp one spacing forward, so the retry cannot land back on it.

## The operator view

```sh
npx -y @tiny-fish/cli@latest auth login   # browser; writes ~/.tinyfish/config.json
pi                                        # the extension captures that key into accounts.json
```

Or skip the browser and paste one, from anywhere:

```sh
printf '%s' '<key>' | "$(dirname "$(readlink -f ~/.pi/agent/extensions/tinyfish/bin/tinyfish-auth-set)")/../auth-set.ts"
```

Shorter, once you are in the repo: `.pi/agent/extensions/tinyfish/bin/tinyfish-auth-set`.

The extension reads `~/.tinyfish/config.json` once at session start and appends a key the store does
not already hold, mode `0600`. Pressing login again with the same account adds nothing, and pasting a
key that is already there reports which entry holds it. No key at all throws the absolute command.

`accounts.json`:

```json
{ "accounts": [{ "id": "a1", "label": "kevin", "key": "tf_...", "weight": 1 }], "cursor": "a1" }
```

`cursor` is the account the last request used, saved at shutdown. Delete an entry to retire a key; an
unknown cursor falls back to the first account. `weight` multiplies pacing allowance, `1` unless an
account is entitled to more.

## The pool

```ts
// ./pool.ts, the whole state
interface Registry { readonly records: readonly AccountRecord[]; readonly cursor: number }
interface AccountRecord {
  readonly account: Account;
  readonly health: { kind: "live" } | { kind: "spent"; until: number; walletUrl: string | null } | { kind: "dead" };
  readonly standing: Record<EndpointId, { kind: "open"; lastUsedAt: number | null } | { kind: "cooling"; until: number; limit: Limit }>;
}
```

Death is on both endpoints, cooldown on one, and `readyAt` reads all three arms in one place so
`select` never branches on health itself.

`acquire` stamps synchronously before it returns, so two acquires in one tick take different keys
without a mutex.

## Params and envelopes

`./params.ts` holds the MCP's parameter schemas field for field. `./http.ts` builds the query string,
zero-padding `pub_year_*` to four characters, and the JSON fetch body.

## Env

`TINYFISH_SEARCH_BASE_URL` and `TINYFISH_FETCH_BASE_URL` move the hosts for tests, which point them
at a `Bun.serve` stub. `TINYFISH_ACCOUNTS_FILE` moves the store.

## The review this shipped from

An independent reviewer raised 16 findings against this branch, plus 5 nits. Every one landed as its
own commit, and `test/trailer.test.ts` re-reads the table below, so a commit that loses its `Rule:`
trailer fails the suite. A rule id is that reviewer's label, not the repo's.

| # | Finding | Commit |
| --- | --- | --- |
| H1 | A 429 on fetch was reported as a 30/min search limit | `b3ae964` |
| H2 | An unreadable store was overwritten at shutdown | `c8193ec` |
| M1 | The cap test capped the pool and never the call | `64b41d7` |
| M2 | A dropped acquire rejection fell into the reload | `d903337` |
| M3 | The reload fired on a pool that was merely paced | `d903337` |
| M4 | `CallDeps.poolConfig` had no production caller | `64b41d7` |
| M5 | The no-retry claim sat inside the clock's spacing window | `675045f` |
| M6 | The cap error conflated out-of-credits with paced | `04f87f9` |
| M7 | The skill promised a retired key never reaches the agent | `cb6d92c` |
| L1 | The empty-pool error was absolute, the skill's copy relative | `c0aabd1` |
| L2 | An undeclared 4xx was retried three times | `5d1f149` |
| L3 | The cap clock was locale- and timezone-dependent | `705c14c` |
| L4 | A guessed 429 limit was stored as the server's | `5c5e593` |
| L5 | A 600 s limit rendered as a per-minute rate | `8285b38` |
| L6 | Concurrent cursor writes were last-writer-wins | `48eb231` |
| L7 | `reload` could land the cursor on `null` | `19cdcb1` |
| N1 | Comments restated the code below them | `38ffb93` |
| N2 | The auth-set symlink was a duplicate and broke on checkout | `37633d8` |
| N3 | An intentional abort wrote an `AbortError` trace to stderr | `4ef4ee7` |
| N4 | The cap error never named the keys the call burned | `d534d6e` |
| N5 | The README said `send` writes `X-API-Key` and nothing else | `bc20429` |

H2 and L1 each took a second pass (`9a5e6db`, `004aa22`); the table names the commit that closes
the finding.

## Tests

`bun run test` is the offline suite: it drives the real `acquire`/`release` with a fake clock and a
real `Bun.serve` stub, so nothing about the transport is mocked and no case spends wall-clock time.

`bun run test:smoke` loads the extension into a real `pi -p` run and calls both tools through the
`tools.tinyfish_*` namespace against the stub. It needs a configured provider. The run keeps
`codemode`, which ships as an extension, so it passes `--tools +codemode` and leaves extension
discovery on; isolation comes from a temp `PI_CODING_AGENT_DIR` with no `extensions/` in it.
