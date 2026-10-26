/**
 * The two tools, as plain functions.
 *
 * Kept apart from the extension entry so they can be exercised without pi: `runRepoScout` takes an
 * already-built registry, and `runPackageRepo` takes an optional resolver, so tests swap both for
 * fakes without an `ExtensionContext`.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import { createAgentAdapter, type ScoutModelSource } from "./agent-session.ts";
import { ensureCheckout, headSha, originOf, refreshCheckout } from "./checkout.ts";
import { localRepoIdentity, parseRemoteRepo, sessionFileName, type RepoIdentity } from "./repo-id.ts";
import { REGISTRIES, resolvePackageRepo, type PackageRepoResult, type Registry } from "./registry.ts";
import { ScoutRegistry, type Logger, type ScoutAdapter, type ScoutResult } from "./scout-registry.ts";

/** Root of everything this extension writes. Overridable for tests and for a second mind. */
export const stateRoot = (): string => {
	const override = process.env.PI_SCOUT_HOME;
	return override ? resolve(override) : join(homedir(), ".pi", "scout");
};

export const reposDir = (): string => join(stateRoot(), "repos");
export const sessionsDir = (): string => join(stateRoot(), "sessions");

/** Ten minutes of inactivity, as asked. `PI_SCOUT_IDLE_MS` moves it. */
export const idleMs = (): number => {
	const raw = Number(process.env.PI_SCOUT_IDLE_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
};

/** A report plus its provenance, so the caller sees which checkout and commit answered. */
const withSource = (repo: string, result: ScoutResult, currentSha: string): string =>
	[
		result.report.trim(),
		"",
		"source",
		`repo   ${repo}`,
		`path   ${result.dir}`,
		`sha    ${currentSha}`,
		`thread ${result.sessionFile ?? "(not persisted)"}`,
		`turn   ${result.fresh ? "opened" : "continued"}`,
	].join("\n");

/** Resolve whatever the caller passed: an existing checkout, a URL, or owner/name. */
export const identifyRepo = async (repo: string, cwd: string): Promise<RepoIdentity> => {
	const trimmed = repo.trim();
	if (!trimmed) throw new Error("repo is empty");
	const candidate = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
	if (existsSync(join(candidate, ".git"))) {
		// A local checkout is known by its origin, so a worktree matches its remote's session.
		return localRepoIdentity(candidate, await originOf(candidate));
	}
	return parseRemoteRepo(trimmed);
};

/** Rebuild the identity from a registry key; the key is the only handle the registry keeps. */
export const identityFor = (key: string): RepoIdentity =>
	key.startsWith("local:") ? localRepoIdentity(key.slice("local:".length), undefined) : parseRemoteRepo(key);

export const prepareCheckout = async (key: string): Promise<{ dir: string; display: string }> => {
	const identity = identityFor(key);
	const dir = await ensureCheckout(identity, reposDir());
	// A checkout that sat on disk since yesterday should not answer about yesterday's code.
	await refreshCheckout(dir);
	return { dir, display: identity.display };
};

export type RepoScoutInput = {
	repo: string;
	question: string;
	/** `provider/model`; the caller's model when absent. */
	model?: string;
	thinkingLevel?: ThinkingLevel;
};

/** `provider/model` looked up in the caller's registry. */
const resolveModel = (source: ScoutModelSource, spec: string): Model<any> => {
	const [provider, ...rest] = spec.split("/");
	const id = rest.join("/");
	const found = provider && id ? (source.modelRegistry.find(provider, id) ?? undefined) : undefined;
	if (!found) throw new Error(`model not found: ${spec}. Pass provider/model, e.g. anthropic/claude-sonnet-4-5.`);
	return found;
};

export type BuiltRegistry = { registry: ScoutRegistry; adapter: ScoutAdapter };

/** Build the built-in registry: scratch checkouts plus agent sessions on the caller's model. */
export const buildRegistry = (deps: {
	source: ScoutModelSource;
	thinkingLevel?: ThinkingLevel;
	/** `provider/model`; the source's model when absent. */
	modelOverride?: string;
	log?: Logger;
}): BuiltRegistry => {
	const model = deps.modelOverride ? resolveModel(deps.source, deps.modelOverride) : undefined;
	const adapter = createAgentAdapter({
		source: deps.source,
		thinkingLevel: deps.thinkingLevel,
		model,
		sessionsDir: sessionsDir(),
	});
	return {
		adapter,
		registry: new ScoutRegistry({
			prepare: prepareCheckout,
			adapter,
			sessionFileFor: (key) => join(sessionsDir(), `${sessionFileName(key)}.jsonl`),
			idleMs: idleMs(),
			log: deps.log,
		}),
	};
};

/**
 * Ask one question of a repo's scout.
 *
 * The repo is identified first, so a typo fails before any network. The question then queues behind
 * any earlier question for the same repo, and the idle clock restarts when it settles.
 */
export async function runRepoScout(input: {
	params: RepoScoutInput;
	registry: ScoutRegistry;
	cwd: string;
}): Promise<string> {
	const { params, registry, cwd } = input;
	const question = params.question?.trim();
	if (!question) throw new Error("question is empty");
	const identity = await identifyRepo(params.repo, cwd);
	await mkdir(sessionsDir(), { recursive: true });
	const result = await registry.run(identity.key, question);
	return withSource(identity.display, result, await headSha(result.dir));
}

export type PackageRepoInput = { package: string; registry?: Registry };

const isRegistry = (value: string): value is Registry => (REGISTRIES as readonly string[]).includes(value);

/** A package name to git repos, as text plus the structured result. */
export async function runPackageRepo(
	input: PackageRepoInput,
	resolvePackage: typeof resolvePackageRepo = resolvePackageRepo,
): Promise<{ text: string; data: PackageRepoResult }> {
	const name = input.package?.trim();
	if (!name) throw new Error("package is empty");
	const registry = (input.registry ?? "npm").trim();
	if (!isRegistry(registry)) {
		throw new Error(`unknown registry: ${registry}. Supported: ${REGISTRIES.join(", ")}.`);
	}

	const result = await resolvePackage({ package: name, registry });
	const lines = [
		`package  ${result.package}`,
		`registry ${result.registry}${result.version ? `@${result.version}` : ""}`,
		result.repos.length ? "repos" : "repos    none",
		...result.repos.map((ref) => `- ${ref.url}  (${ref.kind}, ${ref.source}, ${ref.confidence})`),
		...result.warnings.map((warning) => `warning  ${warning}`),
	];
	return { text: lines.join("\n"), data: result };
}
