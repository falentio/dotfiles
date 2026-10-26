/**
 * The scratch checkout: the code a scout session reads.
 *
 * A scout session keeps one working tree for its whole life, and the prompt cache it is built around
 * only holds if that tree does not shift under it: a file read in question 1 and silently changed
 * before question 2 makes the answer wrong with no signal. So a remote repo is cloned into a private
 * scratch dir, while a local repo gets a --shared clone, which hardlinks the object store instead of
 * copying it, and is refreshed before each re-opened session.
 *
 * A pinned ref gets its own directory. Two refs are two different trees, and sharing one directory
 * would let a question about a release be answered by the default branch.
 *
 * Never the caller's worktree: the main agent edits that while a scout is mid-crawl.
 */

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { shortHash, type RepoIdentity } from './repo-id.ts';

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 300_000;

const git = async (args: string[], cwd?: string): Promise<string> => {
	try {
		const { stdout } = await exec('git', args, {
			cwd,
			maxBuffer: 32 * 1024 * 1024,
			timeout: GIT_TIMEOUT_MS,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
		});
		return stdout.trim();
	} catch (error) {
		const stderr =
			error && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : '';
		throw new Error('git ' + args[0] + ' failed: ' + (stderr || (error instanceof Error ? error.message : String(error))));
	}
};

/**
 * A ref as one safe git argument.
 *
 * `git fetch origin <ref>` parses a leading `-` as an option, not a refspec, and
 * `--upload-pack=<cmd>` makes git run <cmd> on this host. So the ref has to be a plain git ref
 * name before it reaches an argv: no leading dash, no whitespace, no `..`, no `@{}`.
 */
export const assertSafeRef = (ref: string): string => {
	const parts = ref.split('/');
	const safe =
		/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref) &&
		!ref.includes('..') &&
		!/[./]$/.test(ref) &&
		!parts.some((part) => part === '' || part.endsWith('.lock'));
	if (!safe) throw new Error('ref is not a git ref: ' + JSON.stringify(ref));
	return ref;
};

/** The scratch directory a repo (and ref) lives in. The ref is hashed raw, so two refs cannot collide. */
export const checkoutDir = (identity: RepoIdentity, reposDir: string, ref?: string): string =>
	join(reposDir, identity.slug + '-' + shortHash(identity.key + (ref ? '@' + ref : '')));

/** The commit a checkout sits at, filling the report's sha. */
export const headSha = async (dir: string): Promise<string> => {
	try {
		return await git(['rev-parse', '--short=12', 'HEAD'], dir);
	} catch {
		return 'unknown';
	}
};

/** One clone URL, normalized enough to compare an origin with the source that cloned it. */
const normalizeOrigin = (value: string): string => value.trim().replace(/\.git$/i, '').replace(/\/+$/, '');

const sameSource = (origin: string, source: string): boolean => {
	if (normalizeOrigin(origin) === normalizeOrigin(source)) return true;
	try {
		return realpathSync(origin) === realpathSync(source);
	} catch {
		return false;
	}
};

export type Checkout = { dir: string; warning?: string };

/**
 * Make sure the checkout for `identity` at `ref` exists, and return its path.
 *
 * Idempotent on purpose: an existing clone is reused when its origin is the source that was asked
 * for. A directory from another repo, or one with no origin, is discarded and cloned again; a clone
 * killed mid-flight leaves one too.
 */
export async function ensureCheckout(
	identity: RepoIdentity,
	reposDir: string,
	ref?: string,
): Promise<Checkout> {
	await mkdir(reposDir, { recursive: true });
	const pinned = ref ? assertSafeRef(ref) : undefined;
	const dir = checkoutDir(identity, reposDir, pinned);

	if (existsSync(dir) && existsSync(join(dir, '.git'))) {
		const origin = await originOf(dir);
		if (origin && sameSource(origin, identity.source)) return { dir };
		await rm(dir, { recursive: true, force: true });
		await clone(identity, dir, pinned);
		return {
			dir,
			warning: `re-cloned ${dir}: its origin ${origin ?? '(none)'} is not ${identity.source}`,
		};
	}

	if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
	await clone(identity, dir, pinned);
	return { dir };
}

const clone = async (identity: RepoIdentity, dir: string, pinned: string | undefined): Promise<void> => {
	await mkdir(dir, { recursive: true });
	if (pinned) {
		// `clone --branch` accepts a branch or a tag, never a commit, so a pinned tree is built by
		// fetching the ref itself and checking out what arrived.
		await git(['init', '--quiet'], dir);
		await git(['remote', 'add', 'origin', identity.source], dir);
		await fetchRef(dir, pinned);
		return;
	}
	const args = ['clone', '--quiet'];
	args.push(...(identity.kind === 'local' ? ['--shared'] : ['--depth', '1']));
	args.push(identity.source, dir);
	await git(args);
};

/** Fetch one ref into `dir` and leave HEAD on it. Throws when git cannot. */
const fetchRef = async (dir: string, ref: string): Promise<void> => {
	const pinned = assertSafeRef(ref);
	try {
		await git(['fetch', '--depth', '1', '--quiet', 'origin', pinned], dir);
		await git(['checkout', '--quiet', 'FETCH_HEAD'], dir);
		return;
	} catch {
		// A server that refuses a shallow fetch of this name still serves its full history, which is
		// how a bare commit ref is reached. Check out the name asked for, never FETCH_HEAD: when the
		// ref is gone, FETCH_HEAD is whatever the default branch happened to be.
		await git(['fetch', '--quiet', 'origin'], dir);
		await git(['checkout', '--quiet', pinned], dir);
	}
};

/**
 * Move an existing tree to the requested ref. Throws on failure: the caller reports it, because a
 * tree that quietly stayed at yesterday's commit is a confident answer about the wrong code.
 */
export async function refreshCheckout(dir: string, ref?: string): Promise<void> {
	if (ref) {
		await fetchRef(dir, ref);
		return;
	}
	await git(['fetch', '--depth', '1', '--quiet', 'origin', 'HEAD'], dir);
	await git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], dir);
}

/** Where a checkout's own git remote points, for identifying a local repo by its origin. */
export async function originOf(dir: string): Promise<string | undefined> {
	try {
		const url = await git(['config', '--get', 'remote.origin.url'], dir);
		return url || undefined;
	} catch {
		return undefined;
	}
}
