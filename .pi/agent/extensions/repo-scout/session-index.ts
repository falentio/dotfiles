/**
 * The session index: where the transcript for one conversation lives.
 *
 * The mapping has to outlive the process. A second pi process that waited for the lock must reopen
 * the file the first one wrote, or the cache it paid for is lost. One file per conversation key
 * means the only writer is the lock holder, so there is no read-modify-write race on a shared index
 * the way a single JSON map would have.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Ten hex characters of the key: enough for a directory name, matched against the key on read. */
export const digestKey = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 10);

/** The index record for one conversation key. */
export const sessionIndexPath = (indexDir: string, key: string): string => join(indexDir, digestKey(key) + ".json");

/** The session file recorded for this key, or undefined when no process has recorded one. */
export const readSessionIndex = async (indexDir: string, key: string): Promise<string | undefined> => {
	try {
		const parsed = JSON.parse(await readFile(sessionIndexPath(indexDir, key), "utf8")) as { key?: string; file?: string };
		// A digest collision must not hand one conversation another's transcript.
		if (parsed.key !== key || typeof parsed.file !== "string") return undefined;
		return parsed.file;
	} catch {
		return undefined;
	}
};

/** Record the session file pi wrote for this key. One writer: the holder of the repo lock. */
export const writeSessionIndex = async (indexDir: string, key: string, file: string): Promise<void> => {
	const path = sessionIndexPath(indexDir, key);
	await mkdir(dirname(path), { recursive: true });
	const temp = path + "." + process.pid + ".tmp";
	await writeFile(temp, JSON.stringify({ key, file, at: Date.now() }));
	await rename(temp, path);
};
