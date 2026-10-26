/**
 * The two tools, as plain functions.
 *
 * Kept apart from the extension entry so they can be exercised without pi: `runRepoScout` takes an
 * already-built registry, and `runPackageRepo` takes an optional resolver, so tests swap both for
 * fakes without an `ExtensionContext`.
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
import {
	PACKAGE_SOURCES,
	resolvePackageRepo,
	type PackageRepoResult,
	type PackageSource,
} from './registry.ts';
import { ScoutRegistry, type Logger, type ScoutAdapter, type ScoutResult } from './scout-registry.ts';

/** Root of everything this extension writes. Overridable for tests and for a second mind. */
export const stateRoot = (): string => {
	const override = process.env.PI_SCOUT_HOME;
	return override ? resolve(override) : join(homedir(), '.pi', 'scout');
};

export const reposDir = (): string => join(stateRoot(), 'repos');
export const sessionsDir = (): string => join(stateRoot(), 'sessions');

/** Ten minutes of inactivity, as asked. PI_SCOUT_IDLE_MS moves it. */
export const idleMs = (): number => {
	const raw = Number(process.env.PI_SCOUT_IDLE_MS);
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

/** Rebuild the identity from a registry key; the key is the only handle the registry keeps. */
export const identityFor = (key: string): RepoIdentity =>
	key.startsWith('local:') ? localRepoIdentity(key.slice('local:'.length), undefined) : parseRemoteRepo(key);

/**
 * What each key was last asked about. The key alone cannot say where a local checkout lives (it is
 * derived from the origin) or which ref was pinned, and without this a local repo would be cloned
 * from its remote instead of read from the tree the caller is working in.
 */
type CheckoutRequest = { identity: RepoIdentity; ref?: string };
const requests = new Map<string, CheckoutRequest>();

/** The registry key for a repo at a ref: two refs are two conversations, not one. */
export const scoutKey = (identity: RepoIdentity, ref?: string): string =>
	ref ? identity.key + '@' + ref : identity.key;

export const prepareCheckout = async (key: string): Promise<{ dir: string; display: string }> => {
	const remembered = requests.get(key);
	const identity = remembered?.identity ?? identityFor(key);
	const ref = remembered?.ref;
	const dir = await ensureCheckout(identity, reposDir(), ref);
	// A checkout that sat on disk since yesterday should not answer about yesterday's code.
	await refreshCheckout(dir, ref);
	return { dir, display: ref ? identity.display + '@' + ref : identity.display };
};

export type ScoutModelChoice = {
	model: Model<any>;
	modelRegistry: Pick<ModelRegistry, 'find'>;
	thinkingLevel?: ThinkingLevel;
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

export type RepoScoutDeps = {
	cwd: string;
	/** The calling thread's model choice, read once per conversation. */
	chooseModel: () => ScoutModelChoice;
	log?: Logger;
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

/** Build the built-in registry: scratch checkouts plus agent sessions on the caller's model. */
export const buildRegistry = (deps: {
	/** Read per conversation open, so a thread that switched models is followed. */
	source: () => ScoutModelSource;
	thinkingLevel?: ThinkingLevel;
	/** provider/model; the source's model when absent. */
	modelOverride?: string;
	log?: Logger;
}): BuiltRegistry => {
	const adapter = createAgentAdapter({
		getSource: deps.source,
		thinkingLevel: deps.thinkingLevel,
		model: deps.modelOverride ? resolveModel(modelChoice(deps.source()), deps.modelOverride) : undefined,
		sessionsDir: sessionsDir(),
	});
	return {
		adapter,
		registry: new ScoutRegistry({
			prepare: prepareCheckout,
			adapter,
			sessionFileFor: (key) => join(sessionsDir(), sessionFileName(key) + '.jsonl'),
			idleMs: idleMs(),
			log: deps.log,
		}),
	};
};

/** The model a source currently names, in the shape the resolver wants. */
const modelChoice = (source: ScoutModelSource): ScoutModelChoice => ({
	model: source.model as Model<any>,
	modelRegistry: source.modelRegistry,
});

/**
 * Ask one question of a repo's scout, optionally at a ref.
 *
 * The repo is identified first, so a typo fails before any network. The question then queues behind
 * any earlier question for the same repo and ref, and the idle clock restarts when it settles.
 */
export async function runRepoScout(input: {
	params: RepoScoutInput;
	registry: ScoutRegistry;
	cwd: string;
}): Promise<string> {
	const { params, registry, cwd } = input;
	const question = params.question?.trim();
	if (!question) throw new Error('question is empty');
	const identity = await identifyRepo(params.repo, cwd);
	const ref = params.ref?.trim() || undefined;
	const key = scoutKey(identity, ref);
	requests.set(key, { identity, ref });
	await mkdir(sessionsDir(), { recursive: true });
	const result = await registry.run(key, question);
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
const repoLine = (repo: PackageRepoResult['repos'][number]): string =>
	[
		'- ' + repo.url + '  (' + repo.kind + ', ' + repo.via + ', ' + repo.confidence + ')',
		repo.ref ? 'ref ' + repo.ref + ' (' + repo.refKind + ')' : 'ref none',
	].join('  ');

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
	const target = result.repos.find((repo) => repo.kind === 'repository' && repo.confidence === 'stated');
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