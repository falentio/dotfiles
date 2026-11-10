#!/usr/bin/env bun
/** `tinyfish auth set`: append one pasted key to the store. Reads stdin, so it works piped and pasted. */
import { addAccount, readStore, STORE_PATH } from "./accounts.ts";

const key = (await Bun.stdin.text()).trim();

if (key === "") {
	console.error("usage: printf '%s' '<key>' | tinyfish-auth-set");
	process.exit(1);
}

const before = await readStore();
const after = await addAccount(key, before);

if (after === before) console.log(`already in ${STORE_PATH}`);
else console.log(`added key ${after.accounts.at(-1)?.id} to ${STORE_PATH}`);
