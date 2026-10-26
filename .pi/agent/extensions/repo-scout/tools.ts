/**
 * The two tools, as plain functions.
 *
 * Kept apart from the extension entry so they can be exercised without pi: `runRepoScout` takes an
 * already-built registry and the caller's model choice, and `runPackageRepo` takes an optional
 * resolver, so tests swap both for fakes without an `ExtensionContext`.
 *
 * A repo question carries everything the registry needs to key it: the repo and the ref. The model
 * and thinking level travel with the question too, because the conversation is rebound to them; they
 * do not split one repo's transcript into several.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai/compat';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { createAgentAdapter, type ScoutModelSource } from './agent-session.ts';
import { ensureCheckout, headSha, originOf, refreshCheckout } from './checkout.ts';
import { localRepoIdentity, parseRemoteRepo, sessionFileName, type RepoIdentity } from './repo-id.ts';
import { PACKAGE_SOURCES, cloneTarget, resolvePackageRepo, type PackageRepoResult, type PackageSource } from './registry.ts';
import { conversationKey, ScoutRegistry, type Logger, type ScoutAdapter, type ScoutResult } from './scout-registry.ts';
import { digestKey, readSessionIndex, writeSessionIndex } from './session-index.ts';
import { acquireLock } from './state-lock.ts';

/** Root of everything this extension writes. Overridable for tests and for a second mind. */
export const stateRoot = (): string => {
	const override = process.env.PI_SCOUT_HOME;
	return override ? resolve(override) : join(homedir(), '.pi', 'scout');
};

export const reposDir = (): string => join(stateRoot(), 'repos');
export const sessionsDir = (): string => join(stateRoot(), 'sessions');
/** One lock per repo and ref, so two pi processes queue instead of opening two sessions. */
export const locksDir = (): string => join(stateRoot(), 'locks');
/** The transcript index, one file per conversation key. */
export const sessionsIndexDir = (): string => join(sessionsDir(), 'keys');

/** Ten minutes of inactivity, as asked. PI_SCOUT_IDLE_MS moves it. */
export const idleMs = (): number => {
	const raw = Number(process.env.PI_SCOUT_IDLE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
};

/** One turn's ceiling. PI_SCOUT_TURN_MS moves it. */
export const turnMs = (): number => {
	const raw = Number(process.env.PI_SCOUT_TURN_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 900_000;
};

/** How long a second process waits for the lock. PI_SCOUT_LOCK_MS moves it. */
export const lockWaitMs = (): number => {
	const raw = Number(process.env.PI_SCOUT_LOCK_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
};

/** The report plus its provenance, so the caller sees which tree and commit answered. */
const withSource = (repo: string, result: ScoutResult, currentSha: string): string =>
	[
		result.report.trim(),
		'',
		'source',
		'repo   ' + repo,
		'path   ' + result.dir,
		'sha    ' + currentSha,
		'thread ' + (result.sessionFile ?? '(not persisted)'),
		'turn   ' + (result.fresh ? 'opened' : 'continued'),
		...result.warnings.map((warning) => 'warning ' + warning),
	].join('\n');

/** Resolve whatever the caller passed: an existing checkout, a URL, or owner/name. */
export const identifyRepo = async (repo: string, cwd: string): Promise<RepoIdentity> => {
	const trimmed = repo.trim();
	if (!trimmed) throw new Error('repo is empty');
	const candidate = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	if (existsSync(join(candidate, '.git'))) {
		// A local checkout is known by its origin, so a worktree matches its remote's session.
		return localRepoIdentity(candidate, await originOf(candidate));
	}
	return parseRemoteRepo(trimmed);
};

/** Clone the tree for a request when it is missing, and verify an existing tree belongs to it. */
export const checkoutFor = async (request: { repo: RepoIdentity; ref?: string }): Promise<{ dir: string; display: string; warning?: string }> => {
	const { dir, warning } = await ensureCheckout(request.repo, reposDir(), request.ref);
	return { dir, display: request.ref ? request.repo.display + '@' + request.ref : request.repo.display, warning };
};

export type ScoutModelChoice = {
	model: Model<any>;
	modelRegistry: Pick<ModelRegistry, 'find'>;
};

export type RepoScoutInput = {
	repo: string;
	question: string;
	/** A tag, branch, or commit. Read that tree, in its own checkout and conversation. */
	ref?: string;
	/** provider/model; the caller's model when absent. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
};

/** provider/model looked up in the caller's registry. */
const resolveModel = (base: ScoutModelChoice, spec: string): Model<any> => {
	const [provider, ...rest] = spec.split('/');
	const id = rest.join('/');
	const found = provider && id ? (base.modelRegistry.find(provider, id) ?? undefined) : undefined;
	if (!found) throw new Error('model not found: ' + spec + '. Pass provider/model, e.g. anthropic/claude-sonnet-4-5.');
	return found;
};

export type BuiltRegistry = { registry: ScoutRegistry; adapter: ScoutAdapter };

/** Build the one registry: scratch checkouts plus agent sessions on the caller's model. */
export const buildRegistry = (deps: {
	/** Read per conversation open, for the provider runtime. */
	source: () => ScoutModelSource;
	log?: Logger;
}): BuiltRegistry => {
	const adapter = createAgentAdapter({ getSource: deps.source, sessionsDir: sessionsDir() });
	// The lock is keyed exactly like the conversation, so a ref gets its own lock and its own tree.
	const lockDirFor = (request: { repo: RepoIdentity; ref?: string }): string =>
		join(locksDir(), digestKey(conversationKey(request)) + '.lock');
	return {
		adapter,
		registry: new ScoutRegistry({
			acquire: (request, signal) =>
				acquireLock(
					{
						dir: lockDirFor(request),
						label: 'the scout for ' + (request.ref ? request.repo.display + '@' + request.ref : request.repo.display),
						waitMs: lockWaitMs(),
					},
					signal,
				),
			checkout: checkoutFor,
			refresh: refreshCheckout,
			adapter,
			sessionFileFor: (key) => readSessionIndex(sessionsIndexDir(), key),
			newSessionFile: (key) => join(sessionsDir(), sessionFileName(key)),
			rememberSession: (key, file) => writeSessionIndex(sessionsIndexDir(), key, file),
			idleMs: idleMs(),
			turnMs: turnMs(),
			log: deps.log,
		}),
	};
};

/**
 * Ask one question of a repo's scout, optionally at a ref.
 *
 * The repo is identified first, so a typo fails before any network. The question then queues behind
 * any earlier question for the same repo and ref, in this process or another, and the idle clock
 * restarts when it settles.
 */
export async function runRepoScout(input: {
	params: RepoScoutInput;
	registry: ScoutRegistry;
	cwd: string;
	choice: ScoutModelChoice;
	signal?: AbortSignal;
}): Promise<string> {
	const { params, registry, cwd, choice } = input;
	const question = params.question?.trim();
	if (!question) throw new Error('question is empty');
	const identity = await identifyRepo(params.repo, cwd);
	const ref = params.ref?.trim() || undefined;
	const model = params.model ? resolveModel(choice, params.model) : choice.model;
	await mkdir(sessionsDir(), { recursive: true });
	const result = await registry.run(
		{
			repo: identity,
			ref,
			model,
			thinkingLevel: params.thinkingLevel ?? 'medium',
			question,
		},
		input.signal,
	);
	return withSource(ref ? identity.display + '@' + ref : identity.display, result, await headSha(result.dir));
}

export type PackageRepoInput = {
	package: string;
	/** npm | jsr | crate | pypi | dockerhub. Default npm. */
	source?: PackageSource;
	/** A published version; the registry latest when absent. */
	version?: string;
};

const isSource = (value: string): value is PackageSource =>
	(PACKAGE_SOURCES as readonly string[]).includes(value);

/** One repo line: URL, provenance, and the confirmed ref, if any. */
const repoLine = (repo: PackageRepoResult['repos'][number]): string => {
	const ref = repo.ref
		? 'ref ' + repo.ref + ' (' + repo.refKind + ')'
		: repo.refCandidates.length
			? 'ref none (tried ' + repo.refCandidates.join(', ') + ')'
			: 'ref none';
	return ['- ' + repo.url + '  (' + repo.kind + ', ' + repo.via + ', ' + repo.confidence + ')', ref].join('  ');
};

/** A package name to repos at a ref, as text plus the structured result. */
export async function runPackageRepo(
	input: PackageRepoInput,
	resolvePackage: typeof resolvePackageRepo = resolvePackageRepo,
): Promise<{ text: string; data: PackageRepoResult }> {
	const name = input.package?.trim();
	if (!name) throw new Error('package is empty');
	const source = (input.source ?? 'npm').trim();
	if (!isSource(source)) {
		throw new Error('unknown source: ' + source + '. Supported: ' + PACKAGE_SOURCES.join(', ') + '.');
	}
	const version = input.version?.trim() || undefined;

	const result = await resolvePackage({ package: name, source, version });
	// Only a stated repository is offered as a target; a guess is information, not a destination.
	const target = cloneTarget(result);
	const lines = [
		'package  ' + result.package,
		'source   ' + result.source,
		'version  ' + (result.version ?? '(unknown)'),
		result.repos.length ? 'repos' : 'repos    none',
		...result.repos.map(repoLine),
	];
	if (target) {
		lines.push('');
		lines.push('clone    ' + target.url + (target.ref ? ' ref=' + target.ref : ' ref=(default branch)'));
	}
	lines.push(...result.warnings.map((warning) => 'warning  ' + warning));
	return { text: lines.join('\n'), data: result };
}
