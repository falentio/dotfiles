import { describe, expect, it } from "bun:test";
import { createPool, graded, readyAt, select, stamped, type Registry } from "../pool.ts";
import { clock, seeded, storeOf } from "./fixture.ts";

const registryOf = (...ids: string[]): Registry => ({ records: seeded(storeOf(...ids)), cursor: -1 });

const rateLimited = (windowMs: number, limit = 30) => ({
	kind: "rate-limited" as const,
	windowMs,
	limit: { limit, unit: "minute", windowSeconds: Math.round(windowMs / 1000) },
});

it("stamps the taken account and moves the cursor onto it", () => {
	const registry = stamped(registryOf("a1", "a2"), 1, "search", 5_000);
	expect(registry.cursor).toBe(1);
	expect(registry.records[1]?.standing.search).toEqual({ kind: "open", lastUsedAt: 5_000 });
});

it("rotates to the next account because the stamp paces the one just taken", () => {
	const registry = graded(stamped(registryOf("a1", "a2"), 0, "search", 1_000), "a1", "search", { kind: "ok" }, 1_000);
	expect(select(registry, "search", 1_000)).toEqual({ kind: "take", index: 1 });
});

it("cools one endpoint only, and only until its window ends", () => {
	const registry = graded(registryOf("a1"), "a1", "search", rateLimited(60_000), 0);
	expect(readyAt(registry.records[0]!, "search")).toBe(60_000);
	expect(readyAt(registry.records[0]!, "fetch")).toBe(Number.NEGATIVE_INFINITY);
});

it("pushes the pacing stamp a spacing past the last use on transient, so the retry cannot land back", () => {
	// 60_000 ms / 30 per window is a 2 s spacing: stamped 2 s forward, then 2 s of pacing on top.
	const registry = graded(registryOf("a1", "a2"), "a1", "search", { kind: "transient" }, 0);
	expect(readyAt(registry.records[0]!, "search")).toBe(4_000);
	expect(select(registry, "search", 0)).toEqual({ kind: "take", index: 1 });
});

it("retires a dead key on both endpoints", () => {
	const registry = graded(registryOf("a1", "a2"), "a1", "search", { kind: "dead-key" }, 0);
	expect(readyAt(registry.records[0]!, "search")).toBe(Number.POSITIVE_INFINITY);
	expect(readyAt(registry.records[0]!, "fetch")).toBe(Number.POSITIVE_INFINITY);
	expect(select(registry, "fetch", 0)).toEqual({ kind: "take", index: 1 });
});

it("parks a spent account until its cooldown, keeping the wallet url", () => {
	const registry = graded(registryOf("a1"), "a1", "search", { kind: "spent", walletUrl: "https://wallet" }, 0);
	expect(registry.records[0]?.health).toEqual({ kind: "spent", until: 900_000, walletUrl: "https://wallet" });
});

it("prefers a due live key over a due spent one the rotation would reach first", () => {
	const registry = graded(registryOf("a1", "a2"), "a2", "search", { kind: "spent", walletUrl: null }, 0);
	expect(select(registry, "search", 900_000)).toEqual({ kind: "take", index: 0 });
});

it("still takes a spent key once it is due when no live key is left", () => {
	const spent = graded(registryOf("a1", "a2"), "a2", "search", { kind: "spent", walletUrl: null }, 0);
	const registry = graded(spent, "a1", "search", { kind: "dead-key" }, 0);
	expect(select(registry, "search", 899_999)).toMatchObject({
		kind: "wait",
		unless: { kind: "all-spent", walletUrl: null },
	});
	expect(select(registry, "search", 900_000)).toEqual({ kind: "take", index: 1 });
});

it("answers wait with the earliest release when nothing is due", () => {
	const one = graded(registryOf("a1", "a2"), "a1", "search", rateLimited(30_000), 0);
	const registry = graded(one, "a2", "search", rateLimited(60_000), 0);
	expect(select(registry, "search", 0)).toEqual({
		kind: "wait",
		readyAt: 30_000,
		unless: {
			kind: "all-cooling",
			endpoint: "search",
			releaseAt: 30_000,
			releaseInMs: 30_000,
			limit: rateLimited(30_000).limit,
			spentCount: 0,
			spentAt: null,
			tried: [],
		},
	});
});

it("counts the spent records behind a paced pool and names the soonest of them", () => {
	const spent = graded(registryOf("a1", "a2", "a3"), "a3", "search", { kind: "spent", walletUrl: null }, 0);
	const one = graded(spent, "a1", "search", rateLimited(30_000), 0);
	const registry = graded(one, "a2", "search", rateLimited(90_000), 0);
	expect(select(registry, "search", 0)).toEqual({
		kind: "wait",
		readyAt: 30_000,
		unless: {
			kind: "all-cooling",
			endpoint: "search",
			releaseAt: 30_000,
			releaseInMs: 30_000,
			limit: rateLimited(30_000).limit,
			spentCount: 1,
			spentAt: 900_000,
			tried: [],
		},
	});
});

it("answers no-accounts for an empty store and all-dead when every key is retired", () => {
	expect(select({ records: [], cursor: 0 }, "search", 0)).toEqual({
		kind: "exhausted",
		reason: { kind: "no-accounts" },
	});
	const registry = graded(registryOf("a1"), "a1", "search", { kind: "dead-key" }, 0);
	expect(select(registry, "search", 0)).toEqual({ kind: "exhausted", reason: { kind: "all-dead" } });
});

describe("acquire", () => {
	it("hands out successive keys in round-robin order", async () => {
		const time = clock();
		const pool = createPool({ store: storeOf("a1", "a2", "a3"), now: time.now, wait: time.wait });
		const taken: string[] = [];
		for (let i = 0; i < 3; i += 1) {
			const lease = await pool.acquire("search");
			taken.push(lease.account.id);
			lease.release({ kind: "ok" });
		}
		expect(taken).toEqual(["a1", "a2", "a3"]);
	});

	it("sleeps to the earliest release and then serves", async () => {
		const time = clock();
		const pool = createPool({ store: storeOf("a1"), now: time.now, wait: time.wait });
		const first = await pool.acquire("search");
		first.release(rateLimited(4_000));
		const second = await pool.acquire("search");
		expect(time.waits).toEqual([4_000]);
		expect(second.account.id).toBe("a1");
	});

	it("keeps the fetch budget when search is cooling", async () => {
		const time = clock();
		const pool = createPool({ store: storeOf("a1"), now: time.now, wait: time.wait });
		const lease = await pool.acquire("search");
		lease.release(rateLimited(60_000));
		expect((await pool.acquire("fetch")).account.id).toBe("a1");
	});

	it("throws past its own configured cap when the caller passes no deadline", async () => {
		const time = clock();
		const pool = createPool({ store: storeOf("a1"), now: time.now, wait: time.wait, config: { maxWaitMs: 10_000 } });
		const lease = await pool.acquire("search");
		lease.release(rateLimited(60_000));
		await expect(pool.acquire("search")).rejects.toThrow("search: 30/minute");
		expect(time.waits).toEqual([]);
	});

	it("takes an explicit deadline over its own config", async () => {
		const time = clock();
		const pool = createPool({ store: storeOf("a1"), now: time.now, wait: time.wait });
		const lease = await pool.acquire("search");
		lease.release(rateLimited(60_000));
		await expect(pool.acquire("search", undefined, time.now() + 5_000)).rejects.toThrow("search: 30/minute");
	});

	it("rejects an abort before the stamp, leaving the account unpaced", async () => {
		const abort = new AbortController();
		const pool = createPool({
			store: storeOf("a1"),
			now: () => 0,
			wait: (_ms, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		});
		const lease = await pool.acquire("search");
		lease.release(rateLimited(60_000));
		const waiting = pool.acquire("search", abort.signal);
		abort.abort();
		await expect(waiting).rejects.toThrow("aborted");
		expect(pool.snapshot().records[0]?.standing.search).toMatchObject({ kind: "cooling" });
	});

	it("releases only once, so a second release cannot grade twice", async () => {
		const pool = createPool({ store: storeOf("a1"), now: () => 0 });
		const lease = await pool.acquire("search");
		lease.release(rateLimited(60_000));
		lease.release({ kind: "ok" });
		expect(pool.snapshot().records[0]?.standing.search).toMatchObject({ kind: "cooling" });
	});

	it("revives an empty pool from a reload without a restart", async () => {
		const pool = createPool({ store: storeOf() });
		pool.reload(storeOf("a1"));
		expect((await pool.acquire("search")).account.id).toBe("a1");
	});
});

it("keeps the cursor on its own account across a reload that drops one ahead of it", async () => {
	const pool = createPool({ store: storeOf("a1", "a2", "a3"), now: () => 0 });
	await pool.acquire("search");
	await pool.acquire("search");
	pool.reload(storeOf("a2", "a3"));
	expect(pool.snapshot().cursor).toBe(0);
	expect((await pool.acquire("search")).account.id).toBe("a3");
});

it("puts the cursor back at the start when a reload drops the account it named", async () => {
	const pool = createPool({ store: storeOf("a1", "a2"), now: () => 0 });
	await pool.acquire("search");
	pool.reload(storeOf("a2"));
	expect(pool.snapshot().cursor).toBe(-1);
	expect((await pool.acquire("search")).account.id).toBe("a2");
});

it("keeps the cooldown and the health of a record a reload re-seeds", async () => {
	const pool = createPool({ store: storeOf("a1"), now: () => 0 });
	const lease = await pool.acquire("search");
	lease.release(rateLimited(60_000));
	pool.reload(storeOf("a1", "a2"));
	expect(pool.snapshot().records[0]?.standing.search).toMatchObject({ kind: "cooling" });
	expect(pool.snapshot().records[1]?.standing.search).toEqual({ kind: "open", lastUsedAt: null });
});
