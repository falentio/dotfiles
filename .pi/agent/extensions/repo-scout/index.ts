/**
 * repo-scout: one tool call replaces spawning and forking a scout subagent.
 *
 * `repo_scout` keeps one `AgentSession` per repo: the same conversation, so the provider prompt cache
 * is reused; one question at a time; evicted after ten quiet minutes and reopened from its session
 * file, so the cache survives the eviction. `package_repo` answers the question before it: which git
 * repo serves this package.
 *
 * The rules live in `tools.ts` (both tools, paths), `scout-registry.ts` (queue, idle clock),
 * `repo-id.ts` (identity) and `registry.ts` (package provenance). This file is the wiring.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { REGISTRIES } from "./registry.ts";
import {
	buildRegistry,
	runPackageRepo,
	runRepoScout,
	type BuiltRegistry,
	type RepoScoutInput,
} from "./tools.ts";

const log = {
	info: (message: string) => console.error(`[repo-scout] ${message}`),
	warn: (message: string) => console.error(`[repo-scout] ${message}`),
	error: (message: string) => console.error(`[repo-scout] ${message}`),
};

const repoScoutParameters = Type.Object({
	repo: Type.String({
		description:
			"Git repo: a URL (https://github.com/owner/name, git@github.com:owner/name.git), host/owner/name, owner/name (GitHub), or a local checkout path.",
	}),
	question: Type.String({ description: "The question about this repo. Answered by reading the checkout." }),
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
	package: Type.String({ description: "Package name, e.g. zod or @scope/name." }),
	registry: Type.Optional(
		Type.Union([Type.Literal("npm"), Type.Literal("jsr")], {
			description: `Package registry. Supported: ${REGISTRIES.join(", ")}. Default: npm.`,
		}),
	),
});

type RepoScoutParams = RepoScoutInput;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function repoScout(pi: ExtensionAPI) {
	/**
	 * One registry per calling context, keyed by working directory. The context is read on every
	 * conversation open, so a thread that switched models is followed without stale state.
	 */
	const registries = new Map<string, BuiltRegistry>();

	const registryFor = (ctx: ExtensionToolContext, params: RepoScoutParams): BuiltRegistry => {
		const key = `${ctx.cwd}::${params.model ?? ""}::${params.thinkingLevel ?? ""}`;
		const existing = registries.get(key);
		if (existing) return existing;
		const built = buildRegistry({
			source: ctx,
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
			"Ask a question about a codebase and get a scout report with findings anchored to path:line. Keeps one cached agent session per repo: follow-up questions on the same repo reuse the conversation. Use it instead of spawning a subagent to crawl code. The session is evicted after 10 idle minutes and reopened from disk on the next question.",
		parameters: repoScoutParameters,
		exposure: "codemode",
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
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
			"Resolve a package name from a registry (npm, jsr) to the git repo URLs that serve it, with provenance: the manifest's own repository first, a GitHub name search as a marked guess. Pass a returned url to repo_scout.",
		parameters: packageRepoParameters,
		exposure: "codemode",
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_id: string, params: { package: string; registry?: "npm" | "jsr" }) {
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
