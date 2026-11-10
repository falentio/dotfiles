import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { account, clock, storeOf, type Clock } from "./fixture.ts";
import { callPool, createClient, type CallDeps } from "../client.ts";
import { createPool, type Outcome } from "../pool.ts";
import { json, startStub, type Stub } from "./stub.ts";

let stub: Stub;
let time: Clock;
let shared: ReturnType<typeof createPool>;

beforeAll(() => {
	stub = startStub();
	process.env.TINYFISH_SEARCH_BASE_URL = stub.searchBase;
	process.env.TINYFISH_FETCH_BASE_URL = stub.fetchBase;
});

afterAll(() => stub.stop());

beforeEach(() => {
	stub.seen.length = 0;
	time = clock();
	shared = pool("a1", "a2");
});

/** The pool waits on the test clock, so a wait advances the pacing instead of parking the run. */
const pool = (...ids: string[]) => createPool({ store: storeOf(...ids), now: time.now, wait: time.wait });

const deps = (overrides: Partial<CallDeps> = {}): CallDeps => ({
	pool: shared,
	config: { maxTransient: 3, backoffMs: () => 0 },
	...overrides,
});

const search = { endpoint: "search" as const, params: { query: "q" } };

/** A transport that records the key it was handed and replays a script, repeating the last arm. */
const scripted = (outcomes: readonly Outcome[], seen: string[] = []) => {
	let turn = 0;
	return async (_request: unknown, lease: { account: { key: string } }) => {
		seen.push(lease.account.key);
		const outcome = outcomes[Math.min(turn, outcomes.length - 1)] ?? { kind: "ok" as const };
		turn += 1;
		return outcome.kind === "ok" ? { outcome, body: { results: [] } } : { outcome };
	};
};

describe("callPool rotation", () => {
	it("sends two calls to two different keys", async () => {
		const keys: string[] = [];
		const wire = scripted([{ kind: "ok" }], keys);
		await callPool(deps({ transport: wire }), search);
		await callPool(deps({ transport: wire }), search);
		expect(keys).toEqual(["key-a1", "key-a2"]);
	});

	it("rotates off a rate-limited key and back after its window", async () => {
		const keys: string[] = [];
		const wire = scripted(
			[{ kind: "rate-limited", windowMs: 5_000, limit: { limit: 30, unit: "minute", windowSeconds: 5 } }, { kind: "ok" }],
			keys,
		);
		const only = pool("a1");
		const first = await callPool(deps({ pool: only, transport: wire }), search);
		const second = await callPool(deps({ pool: only, transport: wire }), search);
		expect(first).toEqual({ results: [] });
		expect(second).toEqual({ results: [] });
		expect(keys).toEqual(["key-a1", "key-a1", "key-a1"]);
		// The 5 s cooldown, then the pacing floor the release left on the key.
		expect(time.waits).toEqual([5_000, 2_000]);
	});

	it("never re-enters a dead key", async () => {
		const keys: string[] = [];
		const wire = scripted([{ kind: "dead-key" }, { kind: "ok" }], keys);
		await callPool(deps({ transport: wire }), search);
		await callPool(deps({ transport: wire }), search);
		expect(keys).toEqual(["key-a1", "key-a2", "key-a2"]);
	});

	it("does not rotate on an invalid request", async () => {
		const keys: string[] = [];
		const wire = scripted([{ kind: "invalid", error: { type: "tinyfish-invalid", status: 400, body: {} } }], keys);
		await expect(callPool(deps({ transport: wire }), search)).rejects.toThrow("rejected the request");
		expect(keys).toEqual(["key-a1"]);
	});
});

describe("callPool transient", () => {
	it("rotates to the next key instead of retrying the one that failed", async () => {
		const keys: string[] = [];
		const wire = scripted([{ kind: "transient" }, { kind: "ok" }], keys);
		await callPool(deps({ transport: wire }), search);
		expect(keys).toEqual(["key-a1", "key-a2"]);
	});

	it("spends the same budget on a thrown transport failure as on a 5xx", async () => {
		let turn = 0;
		const wire = async () => {
			turn += 1;
			throw new Error("socket hang up");
		};
		await expect(callPool(deps({ transport: wire }), search)).rejects.toThrow("failed 4 times");
		expect(turn).toBe(4);
	});

	it("gives up after three transient turns", async () => {
		const keys: string[] = [];
		const wire = scripted([{ kind: "transient" }], keys);
		await expect(callPool(deps({ transport: wire }), search)).rejects.toThrow("failed 4 times in a row");
		expect(keys).toHaveLength(4);
	});

	it("backs off by a doubling schedule", async () => {
		const slept: number[] = [];
		const wire = scripted([{ kind: "transient" }]);
		await expect(
			callPool(
				deps({
				transport: wire,
				config: { maxTransient: 3, backoffMs: (turn) => 250 * 2 ** (turn - 1) },
				sleep: async (ms) => void slept.push(ms),
			}),
				search,
			),
		).rejects.toThrow();
		expect(slept).toEqual([250, 500, 1000]);
	});
});

describe("the cap", () => {
	it("throws naming the endpoint and its limit rather than sleeping past five minutes", async () => {
		const talkative = createPool({ store: storeOf("a1"), now: time.now, wait: time.wait, config: { maxWaitMs: 10_000 } });
		const lease = await talkative.acquire("search");
		lease.release({ kind: "rate-limited", windowMs: 600_000, limit: { limit: 30, unit: "minute", windowSeconds: 600 } });
		await expect(callPool(deps({ pool: talkative, transport: scripted([{ kind: "ok" }]) }), search)).rejects.toThrow(
			"search: 30/minute",
		);
		expect(time.waits).toEqual([]);
	});
});

describe("the store reload", () => {
	it("picks up a key added out of process when the pool is empty, once", async () => {
		let reads = 0;
		const reload = async () => {
			reads += 1;
			return storeOf("a1");
		};
		await callPool(deps({ pool: pool(), transport: scripted([{ kind: "ok" }]), reload }), search);
		expect(reads).toBe(1);
	});

	it("reloads only once per call, then reports the empty store", async () => {
		let reads = 0;
		const reload = async () => {
			reads += 1;
			return storeOf();
		};
		await expect(callPool(deps({ pool: pool(), transport: scripted([{ kind: "ok" }]), reload }), search)).rejects.toThrow(
			"tinyfish-auth-set",
		);
		expect(reads).toBe(1);
	});
});

describe("the wire", () => {
	it("sends the key as X-API-Key and returns the search body unparsed", async () => {
		const live = createPool({ store: { accounts: [account("a1", "live-key")], cursor: null }, now: time.now, wait: time.wait });
		const body = await createClient(deps({ pool: live })).search({ query: "tiny fish", page: 2 });
		expect(stub.seen).toEqual(["live-key"]);
		expect(body).toEqual({ query: "q", results: [], total_results: 0, page: 0 });
	});

	it("zero-pads publication years onto the query string", async () => {
		const urls: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				urls.push(request.url);
				return Response.json({ query: "q", results: [], total_results: 0, page: 0 });
			},
		});
		process.env.TINYFISH_SEARCH_BASE_URL = `http://127.0.0.1:${server.port}/search`;
		try {
			await createClient(deps()).search({ query: "q", pub_year_min: 2019 });
			expect(new URL(urls[0] ?? "").searchParams.get("pub_year_min")).toBe("2019");
			await createClient(deps()).search({ query: "q", pub_year_min: 42 });
			expect(new URL(urls[1] ?? "").searchParams.get("pub_year_min")).toBe("0042");
		} finally {
			server.stop(true);
			process.env.TINYFISH_SEARCH_BASE_URL = stub.searchBase;
		}
	});

	it("posts the fetch body as JSON", async () => {
		const bodies: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				bodies.push(await request.text());
				return Response.json({ results: [], errors: [] });
			},
		});
		process.env.TINYFISH_FETCH_BASE_URL = `http://127.0.0.1:${server.port}`;
		try {
			await createClient(deps()).fetchContent({
				urls: ["https://example.com"],
				format: "markdown",
				links: false,
				image_links: false,
				page_metadata: true,
			});
			expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ urls: ["https://example.com"], page_metadata: true });
		} finally {
			server.stop(true);
			process.env.TINYFISH_FETCH_BASE_URL = stub.fetchBase;
		}
	});

	it("keeps a per-URL failure in errors instead of throwing", async () => {
		stub.script("key-a1", "fetch", [json(200, { results: [], errors: [{ url: "https://x.test", error: "bot_blocked" }] })]);
		const body = (await createClient(deps()).fetchContent({
			urls: ["https://x.test"],
			format: "markdown",
			links: false,
			image_links: false,
			page_metadata: false,
		})) as { errors: unknown[] };
		expect(body.errors).toHaveLength(1);
	});

	it("surfaces a 400 without rotating", async () => {
		stub.script("key-a1", "search", [json(400, { error: { code: "BAD_REQUEST" } })]);
		stub.script("key-a2", "search", [json(400, { error: { code: "BAD_REQUEST" } })]);
		await expect(createClient(deps()).search({ query: "q" })).rejects.toThrow("HTTP 400");
		expect(stub.seen).toEqual(["key-a1"]);
	});

	it("treats an unclassifiable 502 as transient and backs off", async () => {
		stub.script("key-a1", "search", [json(502, "<html>bad gateway</html>")]);
		stub.script("key-a2", "search", [json(502, "<html>bad gateway</html>")]);
		await expect(createClient(deps()).search({ query: "q" })).rejects.toThrow("failed 4 times");
		expect(stub.seen).toHaveLength(4);
	});

	it("rotates off every spent key and names the wallet url when all are spent", async () => {
		const spent = (key: string) =>
			stub.script(key, "search", [
				json(402, { error: { code: "INSUFFICIENT_CREDITS", details: { wallet_url: "https://wallet" } } }),
			]);
		spent("key-a1");
		spent("key-a2");
		await expect(createClient(deps()).search({ query: "q" })).rejects.toThrow("Top up at https://wallet");
		expect(stub.seen).toEqual(["key-a1", "key-a2"]);
	});

	it("honours Retry-After on a 429 body with no window", async () => {
		stub.script("key-a1", "search", [
			json(429, { error: { code: "RATE_LIMIT_EXCEEDED" } }, { "retry-after": "7" }),
			json(200, { query: "q", results: [], total_results: 0, page: 0 }),
		]);
		const only = pool("a1");
		await callPool(deps({ pool: only, transport: undefined }), search);
		expect(time.waits).toEqual([7_000]);
	});
});
