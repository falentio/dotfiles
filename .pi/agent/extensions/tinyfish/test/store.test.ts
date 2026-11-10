import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAccount, captureFromCli, EMPTY_STORE, parseStore, readStore, saveCursor } from "../accounts.ts";

let dir: string;
let store: string;
let config: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "tinyfish-store-"));
	store = join(dir, "accounts.json");
	config = join(dir, "config.json");
	process.env.TINYFISH_ACCOUNTS_FILE = store;
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

describe("parseStore", () => {
	it("keeps a well-formed entry", () => {
		expect(parseStore({ accounts: [{ id: "a1", label: "kev", key: "k1", weight: 2 }] }).accounts).toMatchObject([
			{ id: "a1", label: "kev", key: "k1", weight: 2 },
		]);
	});
	
	it("drops an entry with no key and keeps the rest", () => {
		const parsed = parseStore({ accounts: [{ id: "a1" }, { id: "a2", key: "k2" }] });
		expect(parsed.accounts.map((account) => account.id)).toEqual(["a2"]);
	});
	
	it("is total over junk", () => {
		for (const junk of [null, 3, "x", [], {}, { accounts: "no" }]) expect(parseStore(junk).accounts).toEqual([]);
	});
	
	it("defaults the weight and the label", () => {
		const [first] = parseStore({ accounts: [{ key: "k1" }] }).accounts;
		expect(first?.weight).toBe(1);
		expect(first?.label).toBe("a1");
	});
	
	it("drops a cursor that names no account", () => {
		expect(parseStore({ accounts: [{ id: "a1", key: "k1" }], cursor: "a9" }).cursor).toBeNull();
		expect(parseStore({ accounts: [{ id: "a1", key: "k1" }], cursor: "a1" }).cursor).toBe("a1");
	});
});

describe("readStore", () => {
	it("yields an empty store and no backup for a missing file", async () => {
		expect(await readStore(store)).toEqual({ store: EMPTY_STORE, brokenAt: null });
	});

	it("keeps the bytes of a file that will not parse and reports where", async () => {
		await writeFile(store, "not json");
		expect(await readStore(store)).toEqual({ store: EMPTY_STORE, brokenAt: `${store}.broken` });
		expect(await readFile(`${store}.broken`, "utf8")).toBe("not json");
	});

	it("keeps the first backup, so a second broken read leaves it alone", async () => {
		await writeFile(store, "first");
		await readStore(store);
		await writeFile(store, "second");
		expect((await readStore(store)).brokenAt).toBe(`${store}.broken`);
		expect(await readFile(`${store}.broken`, "utf8")).toBe("first");
	});

	it("keeps a key another process added between the read and the write", async () => {
		const parsed = parseStore({ accounts: [{ id: "a1", key: "k1" }], cursor: null });
		await writeFile(store, JSON.stringify({ accounts: [{ id: "a1", key: "k1" }, { id: "a2", key: "k2" }], cursor: null }));
		await saveCursor(parsed, "a1");
		expect(JSON.parse(await readFile(store, "utf8"))).toMatchObject({
			accounts: [{ id: "a1" }, { id: "a2" }],
			cursor: "a1",
		});
	});

	it("writes a shutdown cursor from the store it was handed, not from a re-read", async () => {
		await writeFile(store, "not json");
		const loaded = await readStore(store);
		const parsed = parseStore({ accounts: [{ id: "a1", key: "k1" }], cursor: null });
		await saveCursor(parsed, "a1");
		expect(JSON.parse(await readFile(store, "utf8"))).toMatchObject({ accounts: [{ id: "a1", key: "k1" }], cursor: "a1" });
		expect(loaded.store).toEqual(EMPTY_STORE);
	});
});

describe("captureFromCli", () => {
	it("appends the key the CLI left, mode 0600", async () => {
		await writeFile(config, JSON.stringify({ api_key: "k1", account_email: "kev@example.com" }));
		const captured = await captureFromCli(EMPTY_STORE, config);
		expect(captured.accounts.map((account) => account.key)).toMatchObject(["k1"]);
		expect(mode(store)).resolves.toBe(0o600);
	});
	
	it("adds nothing for the same key twice", async () => {
		await writeFile(config, JSON.stringify({ api_key: "k1" }));
		const once = await captureFromCli(EMPTY_STORE, config);
		expect(await captureFromCli(once, config)).toBe(once);
	});
	
	it("ignores a config with no api_key", async () => {
		await writeFile(config, JSON.stringify({ other: 1 }));
		expect(await captureFromCli(EMPTY_STORE, config)).toBe(EMPTY_STORE);
	});
	
	it("ignores a missing config", async () => {
		expect(await captureFromCli(EMPTY_STORE, join(dir, "absent.json"))).toBe(EMPTY_STORE);
	});
});

describe("addAccount", () => {
	it("names the id a duplicate key already holds and writes nothing", async () => {
		const once = await addAccount("k1", EMPTY_STORE);
		const again = await addAccount("k1", once.store);
		expect(again.duplicateOf).toBe("a1");
		expect(again.store).toBe(once.store);
	});
	
	it("names no duplicate for a new key", async () => {
		expect((await addAccount("k1", EMPTY_STORE)).duplicateOf).toBeNull();
	});
	
	it("writes the key with mode 0600", async () => {
		await addAccount("k1", EMPTY_STORE);
		expect(await mode(store)).toBe(0o600);
		expect(JSON.parse(await readFile(store, "utf8")).accounts[0].key).toBe("k1");
	});
	
	it("is idempotent by key", async () => {
		const once = await addAccount("k1", EMPTY_STORE);
		expect((await addAccount("k1", once.store)).store).toBe(once.store);
	});
	
	it("mints an id a deleted middle entry left behind", async () => {
		const store2 = await addAccount("k1", EMPTY_STORE);
		const withGap = { accounts: [store2.store.accounts[0]!], cursor: null };
		const next = await addAccount("k2", withGap);
		expect(next.store.accounts.map((account) => account.id)).toEqual(["a1", "a2"]);
	});
});
