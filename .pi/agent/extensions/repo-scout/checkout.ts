/**
 * The scratch checkout: the code a scout session reads.
 *
 * A scout session keeps one working tree for its whole life, and the prompt cache it is built around
 * only holds if that tree does not shift under it: a file read in question 1 and silently changed
 * before question 2 makes the answer wrong with no signal. So a remote repo is cloned once into a
 * private scratch dir, while a local repo gets a `--shared` clone, which hardlinks the object store
 * instead of copying it.
 *
 * Never the caller's worktree: the main agent edits that while a scout is mid-crawl.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoIdentity } from "./repo-id.ts";

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 300_000;

const git = async (args: string[], cwd?: string): Promise<string> => {
	try {
		const { stdout } = await exec("git", args, {
			cwd,
			maxBuffer: 32 * 1024 * 1024,
			timeout: GIT_TIMEOUT_MS,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
		});
		return stdout.trim();
	} catch (error) {
		const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
		const message = stderr || (error instanceof Error ? error.message : String(error));
		throw new Error(`git ${args[0]} failed: ${message}`);
	}
};

/** The commit a checkout sits at, filling the report's `source.sha`. */
export const headSha = async (dir: string): Promise<string> => {
	try {
		return await git(["rev-parse", "--short=12", "HEAD"], dir);
	} catch {
		return "unknown";
	}
};

/**
 * Make sure `reposDir/<slug>` holds a checkout of `identity`, and return the path.
 *
 * Idempotent on purpose: an existing clone is reused, and a directory that is not a repo (a
 * clone killed mid-flight leaves one) is discarded and redone.
 */
export async function ensureCheckout(identity: RepoIdentity, reposDir: string): Promise<string> {
	await mkdir(reposDir, { recursive: true });
	const dir = join(reposDir, identity.slug);

	if (!existsSync(dir)) {
		// --shared: hardlinks the local object store, so a local clone is instant and thin.
		const cloneArgs = identity.kind === "local" ? ["--shared"] : ["--depth", "1"];
		await rm(dir, { recursive: true, force: true });
		await git(["clone", ...cloneArgs, "--quiet", identity.source, dir]);
		return dir;
	}

	if (!existsSync(join(dir, ".git"))) {
		// A clone that died left something that is not a repo. Remove and retry once.
		await rm(dir, { recursive: true, force: true });
		return ensureCheckout(identity, reposDir);
	}

	return dir;
}

/** Best-effort refresh so a long-lived scratch clone does not answer about old code. */
export async function refreshCheckout(dir: string): Promise<void> {
	await git(["fetch", "--depth", "1", "--quiet", "origin", "HEAD"], dir).catch(() => undefined);
	await git(["reset", "--hard", "--quiet", "FETCH_HEAD"], dir).catch(() => undefined);
}

/** Where a checkout's own git remote points, for identifying a local repo by its origin. */
export async function originOf(dir: string): Promise<string | undefined> {
	try {
		const url = await git(["config", "--get", "remote.origin.url"], dir);
		return url || undefined;
	} catch {
		return undefined;
	}
}
