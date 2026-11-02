/**
 * repo-scout: one tool call replaces spawning and forking a scout subagent.
 *
 * `repo_scout` keeps one `AgentSession` per repo and ref, whatever model asks: one conversation per
 * repo at one version, so the provider prompt cache is reused and two callers read the same crawl.
 * One question at a time, one cross-process lock per repo and ref, evicted after one quiet hour and
 * reopened from its session file, so the cache survives the eviction. A different model rebinds
 * the same transcript instead of starting a second one. `package_repo` answers the question before
 * it: which git repo serves this package, and at which ref.
 *
 * The rules live in `tools.ts` (both tools, paths), `scout-registry.ts` (queue, idle clock,
 * deadline), `repo-id.ts` (identity), `registry.ts` (package provenance and refs) and
 * `checkout.ts` (the scratch tree). This file is the wiring.
 */

import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { lit, obj, opt, str, union, type Annotations, type Schema } from '@earendil-works/pi-schema';
import { PACKAGE_SOURCES, type PackageSource } from './registry.ts';
import { buildRegistry, runPackageRepo, runRepoScout, type BuiltRegistry, type RepoScoutInput } from './tools.ts';

const line = (message: string) => console.error('[repo-scout] ' + message);
const log = { info: line, warn: line, error: line };

const stringLit = <const V extends string>(value: V, options?: Annotations<V>): Schema<V> => ({
	type: 'string',
	...lit(value, options),
});

const repoScoutParameters = obj(
	{
		repo: str({
			description:
				"Git repo: a URL (https://github.com/owner/name, git@github.com:owner/name.git), host/owner/name, owner/name (GitHub), or a local checkout path.",
		}),
		question: str({ description: "The question about this repo. Answered by reading the checkout." }),
		ref: opt(
			str({
				description:
					"A tag, branch, or commit to read instead of the default branch. Each ref gets its own checkout and its own conversation, so it does not disturb the session on the default branch.",
			}),
		),
		model: opt(str({ description: "Override the model as provider/model. Default: the caller's model." })),
		thinkingLevel: opt(
			union(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => stringLit(level)), {
				description: "Thinking level for the scout. Default: medium.",
			}),
		),
	},
	{ open: true },
);

const packageRepoParameters = obj(
	{
		package: str({
			description:
				"Package name: zod, @scope/name, serde, requests, owner/image (Docker Hub), a Go module path (github.com/o/n), a Hex name (phoenix), group:artifact (Maven), a NuGet id (Newtonsoft.Json), or a zpm name (accord or author/name).",
		}),
		source: opt(
			union(PACKAGE_SOURCES.map((source) => stringLit(source)), {
				description: "Package registry. Default: npm. Supported: " + PACKAGE_SOURCES.join(", ") + ".",
			}),
		),
		version: opt(
			str({
				description:
					"A published version; the registry latest when absent. The tool also returns the git tag that serves it, when one exists.",
			}),
		),
	},
	{ open: true },
);

type RepoScoutParams = RepoScoutInput;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function repoScout(pi: ExtensionAPI) {
	/**
	 * One registry for the extension. Identity is the repo and the ref; the model rebinds the same
	 * transcript, and the repo lock keeps other pi processes from opening a second session on it.
	 */
	let current: ExtensionToolContext | undefined;
	let built: BuiltRegistry | undefined;

	const registryFor = (ctx: ExtensionToolContext): BuiltRegistry => {
		current = ctx;
		if (built) return built;
		built = buildRegistry({ source: () => current ?? ctx, log });
		return built;
	};

	pi.registerTool({
		name: "repo_scout",
		label: "Repo scout",
		description:
			"Ask a question about a codebase and get a scout report with findings anchored to path:line. Keeps one cached agent session per repo and ref: follow-up questions reuse the conversation, and a different model continues the same one. Only one process reads a repo at a ref at a time; a second waits for the lock. Use it instead of spawning a subagent to crawl code. A session is evicted after one idle hour and reopened from disk on the next question.",
		parameters: repoScoutParameters,
		exposure: "codemode",
		annotations: { readOnlyHint: false, openWorldHint: true },
		async execute(_id: string, params: RepoScoutParams, signal, _onUpdate, ctx: ExtensionToolContext) {
			if (!ctx.model) throw new Error("repo_scout needs a current model; select one first");
			const { registry } = registryFor(ctx);
			return text(
				await runRepoScout({
					params,
					registry,
					cwd: ctx.cwd,
					choice: { model: ctx.model, modelRegistry: ctx.modelRegistry },
					signal,
				}),
			);
		},
	});

	pi.registerTool({
		name: "package_repo",
		label: "Package repo",
		description:
			"Resolve a package name and version to the git repo that serves it, plus a ref git confirmed exists for that version. Reads npm, jsr, crate, pypi, and dockerhub, and says where each URL came from. Pass url and ref to repo_scout.",
		parameters: packageRepoParameters,
		exposure: "codemode",
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_id: string, params: { package: string; source?: PackageSource; version?: string }) {
			const { text: rendered } = await runPackageRepo(params);
			return text(rendered);
		},
	});

	pi.on("session_shutdown", async () => {
		const pending = built;
		built = undefined;
		current = undefined;
		await pending?.registry.shutdown();
	});
}
