#!/usr/bin/env bun
/** `tinyfish auth set`: append one pasted key to the store. Reads stdin, so it works piped and pasted. */
import { addAccount, readStore, storePath } from "./accounts.ts";

const key = (await Bun.stdin.text()).trim();

if (key === "") {
	console.error("usage: printf '%s' '<key>' | tinyfish-auth-set");
	process.exit(1);
}

const added = await addAccount(key, (await readStore()).store);

if (added.duplicateOf === null) {
	console.log(`added key ${added.store.accounts.at(-1)?.id} to ${storePath()}`);
} else {
	console.log(`already present as ${added.duplicateOf}; delete it from ${storePath()} and re-add to revive`);
}
