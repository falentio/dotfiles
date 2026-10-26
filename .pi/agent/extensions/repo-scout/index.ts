/**
 * repo-scout: one tool call replaces spawning and forking a scout subagent.
 *
 * `repo_scout` keeps one `AgentSession` per repo (and per ref): the same conversation, so the
 * provider prompt cache is reused; one question at a time; evicted after ten quiet minutes and
 * reopened from its session file, so the cache survives the eviction. `package_repo` answers the
 * question before it: which git repo serves this package, and at which ref.
 *
 * The rules live in `tools.ts` (both tools, paths), `scout-registry.ts` (queue, idle clock),
 * `repo-id.ts` (identity), `registry.ts` (package provenance and refs) and `checkout.ts` (the
 * scratch tree). This file is the wiring.
 */

import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { PACKAGE_SOURCES, type PackageSource } from './registry.ts';
import {
	buildRegistry,
	runPackageRepo,
	runRepoScout,
	type BuiltRegistry,
	type RepoScoutInput,
} from './tools.ts';

const line = (message: string) => console.error('[repo-scout] ' + message);
const log = { info: line, warn: line, error: line };

const repoScoutParameters = Type.Object({
	repo: Type.String({
		description:
			"Git repo: a URL (https://github.com/owner/name, git@github.com:owner/name.git), host/owner/name, owner/name (GitHub), or a local checkout path.",
	}),
	question: Type.String({ description: "The question about this repo. Answered by reading the checkout." }),
	ref: Type.Optional(
		Type.String({
			description:
				"A tag, branch, or commit to read instead of the default branch. Each ref gets its own checkout and its own conversation, so it does not disturb the session on the default branch.",
		}),
	),
	model: Type.Optional(Type.String({ description: "Override the model as provider/model. Default: the caller's model." })),
	thinkingLevel: Type.Optional(
		Type.Union(
			[
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{ description: "Thinking level for the scout. Default: medium." },
		),
	),
});

const packageRepoParameters = Type.Object({
	package: Type.String({ description: "Package name: zod, @scope/name, serde, requests, or owner/image for Docker Hub." }),
	source: Type.Optional(
		Type.Union(
			PACKAGE_SOURCES.map((source) => Type.Literal(source)),
			{ description: "Package registry. Default: npm. Supported: " + PACKAGE_SOURCES.join(", ") + "." },
		),
	),
	version: Type.Optional(
		Type.String({
			description:
				"A published version; the registry latest when absent. The tool also returns the git tag that serves it, when one exists.",
		}),
	),
});

type RepoScoutParams = RepoScoutInput;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function repoScout(pi: ExtensionAPI) {
	/**
	 * One registry per (working directory, model, thinking level). The model is not part of the
	 * conversation identity by accident: a session is bound to the model it opened with, so asking for
	 * another model must open another conversation rather than silently re-point the cached one.
	 */
	const registries = new Map<string, BuiltRegistry>();
	/** The context each registry reads at conversation open, refreshed on every call. */
	const contexts = new Map<string, ExtensionToolContext>();

	const registryFor = (ctx: ExtensionToolContext, params: RepoScoutParams): BuiltRegistry => {
		const key = ctx.cwd + "::" + (params.model ?? "") + "::" + (params.thinkingLevel ?? "");
		contexts.set(key, ctx);
		const existing = registries.get(key);
		if (existing) return existing;
		const built = buildRegistry({
			source: () => contexts.get(key) ?? ctx,
			modelOverride: params.model,
			thinkingLevel: params.thinkingLevel,
			log,
		});
		registries.set(key, built);
		return built;
	};

	pi.registerTool({
		name: "repo_scout",
		label: "Repo scout",
		description:
			"Ask a question about a codebase and get a scout report with findings anchored to path:line. Keeps one cached agent session per repo (and per ref): follow-up questions reuse the conversation. Use it instead of spawning a subagent to crawl code. A session is evicted after 10 idle minutes and reopened from disk on the next question.",
		parameters: repoScoutParameters,
		exposure: "codemode",
		// Not idempotent: every call appends a turn to the repo's conversation.
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id: string, params: RepoScoutParams, _signal, _onUpdate, ctx: ExtensionToolContext) {
			if (!ctx.model) throw new Error("repo_scout needs a current model; select one first");
			const { registry } = registryFor(ctx, params);
			return text(await runRepoScout({ params, registry, cwd: ctx.cwd }));
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
		const pending = [...registries.values()];
		registries.clear();
		await Promise.all(pending.map((built) => built.registry.shutdown()));
	});
}