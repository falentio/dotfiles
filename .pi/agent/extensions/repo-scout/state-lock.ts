/**
 * A cross-process mutex for one scratch checkout.
 *
 * pi runs one process per thread, so two threads can ask about one repo at the same time. A kernel
 * flock would be ideal, but Node exposes no binding for it; a lock directory plus an owner file gives
 * the same exclusion with Node alone. `mkdir` is the atomic test-and-set, the pid and heartbeat make
 * a crashed holder detectable, and a waiter that finds a dead owner steals the lock by renaming the
 * directory out from under it.
 *
 * The lock is held for the life of a conversation, not one question: the tree and the transcript are
 * the shared things, and both must not move while another process reads them.
 */

import { hostname } from 'node:os';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SCOUT_CONFIG } from './config.ts';

export type LockOptions = {
	/** The lock path. Usually <stateRoot>/locks/<digest>.lock. */
	dir: string;
	/** What is locked, for the timeout message. */
	label: string;
	/** How long to wait for the holder. Defaults to `SCOUT_CONFIG.lockWaitMs`. */
	waitMs?: number;
	/** Poll interval while waiting. */
	pollMs?: number;
	/** How often the holder proves it is alive. */
	heartbeatMs?: number;
};

/** Release a lock. Safe to call twice; safe when this process no longer owns it. */
export type ReleaseLock = () => Promise<void>;

type Owner = { pid: number; host: string; at: number };

const DEFAULT_POLL_MS = 250;
const DEFAULT_HEARTBEAT_MS = 15_000;
const STALE_FACTOR = 3;
const UNWRITTEN_GRACE_MS = 2_000;

/** Locks this process already holds, so a second conversation on one tree does not deadlock. */
const held = new Map<string, { count: number; release: () => Promise<void> }>();

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('lock wait aborted'));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('lock wait aborted'));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});

const readOwner = async (dir: string): Promise<Owner | undefined> => {
	try {
		const parsed = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')) as Owner;
		return typeof parsed?.pid === 'number' ? parsed : undefined;
	} catch {
		return undefined;
	}
};

const alive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
};

const ageOf = async (dir: string): Promise<number> => {
	for (const path of [join(dir, 'owner.json'), dir]) {
		try {
			return Date.now() - (await stat(path)).mtimeMs;
		} catch {
			// fall through to the next candidate
		}
	}
	return 0;
};

const isStale = async (dir: string, heartbeatMs: number): Promise<boolean> => {
	const age = await ageOf(dir);
	if (age > heartbeatMs * STALE_FACTOR) return true;
	const owner = await readOwner(dir);
	if (!owner) return age > UNWRITTEN_GRACE_MS;
	// A pid is only meaningful on the host that wrote it.
	return owner.host === hostname() ? !alive(owner.pid) : false;
};

const steal = async (dir: string): Promise<void> => {
	const grave = dir + '.stale.' + process.pid + '.' + Date.now();
	try {
		await rename(dir, grave);
	} catch {
		return;
	}
	await rm(grave, { recursive: true, force: true });
};

const ownedByUs = async (dir: string): Promise<boolean> => {
	const owner = await readOwner(dir);
	return Boolean(owner && owner.pid === process.pid && owner.host === hostname());
};

/**
 * Take the lock for `options.dir`, waiting for the holder when another process has it.
 *
 * Resolves with a release function. A waiter whose signal aborts stops waiting; a holder that dies
 * leaves a lock the next waiter can prove stale and steal.
 */
export const acquireLock = async (options: LockOptions, signal?: AbortSignal): Promise<ReleaseLock> => {
	const existing = held.get(options.dir);
	if (existing) {
		existing.count += 1;
		return async () => {
			existing.count -= 1;
			if (existing.count === 0) {
				held.delete(options.dir);
				await existing.release();
			}
		};
	}

	await mkdir(dirname(options.dir), { recursive: true });
	const waitMs = options.waitMs ?? SCOUT_CONFIG.lockWaitMs;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
	const started = Date.now();

	for (;;) {
		if (signal?.aborted) throw new Error('lock wait aborted');
		try {
			await mkdir(options.dir);
			await writeFile(join(options.dir, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		if (await isStale(options.dir, heartbeatMs)) {
			await steal(options.dir);
			continue;
		}
		if (Date.now() - started >= waitMs) {
			const owner = await readOwner(options.dir);
			const who = owner ? `, held by pid ${owner.pid} on ${owner.host}` : '';
			throw new Error(`another pi process holds ${options.label}${who}; waited ${Math.round(waitMs / 1000)}s`);
		}
		await sleep(pollMs, signal);
	}

	const touch = () => {
		const now = new Date();
		void utimes(join(options.dir, 'owner.json'), now, now).catch(() => undefined);
	};
	const heartbeat = setInterval(touch, heartbeatMs);
	heartbeat.unref?.();

	const release = async (): Promise<void> => {
		clearInterval(heartbeat);
		if (await ownedByUs(options.dir)) await rm(options.dir, { recursive: true, force: true });
	};
	held.set(options.dir, { count: 1, release });
	return async () => {
		const current = held.get(options.dir);
		if (!current) return;
		current.count -= 1;
		if (current.count === 0) {
			held.delete(options.dir);
			await current.release();
		}
	};
};
