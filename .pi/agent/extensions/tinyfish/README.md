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
`./.pi/agent/settings.json` sets `codemode.mode: "only"`. A rate limit that used to throw now costs
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
async execute(_id, params, signal) {
  return envelope(await deps().client.search(params, signal));
}
```

Under that, one attempt is a lease: acquire, `send`, release with the outcome, which `settle` writes
down. `callPool` owns the retry loop, so the transport is the wire call and nothing else. `send` is
the only reader of `lease.account.key`; it writes `X-API-Key`, adds
`Content-Type: application/json` on the fetch POST, and nothing else ever holds a raw key.

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

Shorter, once you are in the repo: `./.pi/agent/extensions/tinyfish/bin/tinyfish-auth-set`.

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
  readonly standing: Record<EndpointId, EndpointStanding>;
}
// where an account stands on ONE endpoint: free with its last use, or cooling until a release
type EndpointStanding =
  | { kind: "open"; lastUsedAt: number | null }
  | { kind: "cooling"; until: number; limit: Limit | null };
```

Death is on both endpoints, cooldown on one, and `readyAt` reads all three arms in one place so
`select` never branches on health itself.

`acquire` stamps synchronously before it returns, so two acquires in one tick take different keys
without a mutex.

Open: the deadline is a client concern. `CallDeps.poolConfig` exists only so `callPool` can build
one, while `Pool` already carries a `maxWaitMs` and derives its default from it. Deriving the
deadline inside the pool and dropping the dep reshapes the pool and its tests, more than this pass
holds, so it stays as it is. Nothing else needs the seam: a caller deadline can only shorten the
operator's cap.

## Where this goes past the MCP

Each of these is a choice the port made, not something carried across.

- `iframe_links` is a fetch flag the MCP had and the old skill never named, so it stays in the schema
  and works, and the skill lists it with the other output flags.
- A key that answered 402 or 403 comes back after `SPENT_COOLDOWN_MS`, 15 minutes. Nothing in the spec
  says a spent key returns, and a top up would otherwise need a restart.
- This README is new. It covers the three parties the extension serves (agent, handler, operator) and
  the review it shipped from, and it is not in the PR's scope list.

## Params and envelopes

`./params.ts` holds the MCP's parameter schemas field for field. `./http.ts` builds the query string,
zero-padding `pub_year_*` to four characters, and the JSON fetch body.

## Env

`TINYFISH_SEARCH_BASE_URL` and `TINYFISH_FETCH_BASE_URL` move the hosts for tests, which point them
at a `Bun.serve` stub. `TINYFISH_ACCOUNTS_FILE` moves the store.

## The review this shipped from

An independent reviewer raised 16 findings against this branch, plus 5 nits. Every one landed as its
own commit, and `./test/trailer.test.ts` re-reads the table below, so a commit that loses its `Rule:`
trailer fails the suite. A rule id is that reviewer's label, not the repo's.

| # | Finding | Commit |
| --- | --- | --- |
| H1 | A 429 on fetch was reported as a 30/min search limit | `ec89d44` |
| H2 | An unreadable store was overwritten at shutdown | `cc76b89` |
| M1 | The cap test capped the pool and never the call | `6c9e07b` |
| M2 | A dropped acquire rejection fell into the reload | `b884162` |
| M3 | The reload fired on a pool that was merely paced | `b884162` |
| M4 | `CallDeps.poolConfig` had no production caller | `6c9e07b` |
| M5 | The no-retry claim sat inside the clock's spacing window | `75e4873` |
| M6 | The cap error conflated out-of-credits with paced | `11f15dc` |
| M7 | The skill promised a retired key never reaches the agent | `5251117` |
| L1 | The empty-pool error was absolute, the skill's copy relative | `6697756` |
| L2 | An undeclared 4xx was retried three times | `5592581` |
| L3 | The cap clock was locale- and timezone-dependent | `bde5510` |
| L4 | A guessed 429 limit was stored as the server's | `cb080fb` |
| L5 | A 600 s limit rendered as a per-minute rate | `e7c9ae2` |
| L6 | Concurrent cursor writes were last-writer-wins | `13a0931` |
| L7 | `reload` could land the cursor on `null` | `76f4992` |
| N1 | Comments restated the code below them | `968ee83` |
| N2 | The auth-set symlink was a duplicate and broke on checkout | `8425dae` |
| N3 | An intentional abort wrote an `AbortError` trace to stderr | `a2fb0db` |
| N4 | The cap error never named the keys the call burned | `edc1d70` |
| N5 | The README said `send` writes `X-API-Key` and nothing else | `ecc2a82` |
| S1 | Tool names did not match the MCP's, so old prompts broke | `-` |
| S2 | A call resolved to a string, so the skill's example threw | `-` |
| S3 | A second corrupt store re-reported the first one's backup | `-` |
| S4 | A fetch without the three output flags rejected | `-` |
| S5 | No test called a registered tool | `-` |
| S6 | run_web_automation survived with nothing behind it | `-` |
| S7 | The committed skill checker expected the old names | `-` |
| S8 | The review-fix claim had no list to audit | `-` |
| S9 | The smoke passed `-e` and skipped discovery | `-` |
| S10 | iframe_links came from nowhere | `-` |
| S11 | SPENT_COOLDOWN_MS revived a spent key, unmentioned | `-` |
| S12 | The README was a deliverable outside the scope section | `-` |
| D1 | Bare repo paths in the README | `-` |
| D2 | Seven commits carried no Rule trailer | `-` |
| D3 | One isRecord guard written twice | `-` |
| D4 | The envelope test re-declared the envelope | `-` |
| D5 | seeded re-implemented seedRecords | `-` |
| D6 | Members nothing calls stayed | `-` |
| D7 | poolConfig was a client dep the pool already defaults | `-` |
| D8 | Standing and graded named nothing | `-` |
| D9 | Three comments restated their code | `-` |
| D10 | The smoke sat beside the unit tests, not under smoke/ | `-` |
| D11 | Stray tabs held blank lines in store.test.ts | `-` |

H2 and L1 each took a second pass (`f01946f`, `c1eeb83`); the table names the commit that closes
the finding.

## Tests

`bun run test` is the offline suite under `./test/`: it drives the real `acquire`/`release` with a fake
clock and a real `Bun.serve` stub, so nothing about the transport is mocked and no case spends
wall-clock time.

`bun run test:smoke` is the one run that needs a real provider, and it lives under `./smoke/` beside
the offline suite the way the sibling extensions keep theirs. `./smoke/README.md` has the shape.
