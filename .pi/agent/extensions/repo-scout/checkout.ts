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
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { RepoIdentity } from './repo-id.ts';

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

/** A ref as a directory suffix: one path component, no separators. */
export const sanitizeRef = (ref: string): string =>
	ref
		.replace(/[^\w.-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')

/** The scratch directory a repo (and ref) lives in. */
export const checkoutDir = (identity: RepoIdentity, reposDir: string, ref?: string): string =>
	join(reposDir, ref ? identity.slug + '@' + sanitizeRef(ref) : identity.slug);

/** The commit a checkout sits at, filling the report's sha. */
export const headSha = async (dir: string): Promise<string> => {
	try {
		return await git(['rev-parse', '--short=12', 'HEAD'], dir);
	} catch {
		return 'unknown';
	}
};

/**
 * Make sure the checkout for `identity` at `ref` exists, and return its path.
 *
 * Idempotent on purpose: an existing clone is reused, and a directory that is not a repo (a clone
 * killed mid-flight leaves one) is discarded and redone.
 */
export async function ensureCheckout(
	identity: RepoIdentity,
	reposDir: string,
	ref?: string,
): Promise<string> {
	await mkdir(reposDir, { recursive: true });
	const pinned = ref ? assertSafeRef(ref) : undefined;
	const dir = checkoutDir(identity, reposDir, pinned);

	if (existsSync(dir) && existsSync(join(dir, '.git'))) return dir;

	// A clone that died leaves a directory that is not a repo. Remove and redo.
	if (existsSync(dir)) await rm(dir, { recursive: true, force: true });

	const args = ['clone', '--quiet'];
	args.push(...(identity.kind === 'local' ? ['--shared'] : ['--depth', '1']));
	if (pinned) args.push('--branch', pinned);
	args.push(identity.source, dir);
	await git(args);
	return dir;
}

/** Best-effort refresh, so a long-lived scratch clone does not answer about old code. */
export async function refreshCheckout(dir: string, ref?: string): Promise<void> {
	if (ref) {
		await git(['fetch', '--depth', '1', '--quiet', 'origin', assertSafeRef(ref)], dir).catch(() => undefined);
		await git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], dir).catch(() => undefined);
		return;
	}
	await git(['fetch', '--depth', '1', '--quiet', 'origin', 'HEAD'], dir).catch(() => undefined);
	await git(['reset', '--hard', '--quiet', 'FETCH_HEAD'], dir).catch(() => undefined);
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