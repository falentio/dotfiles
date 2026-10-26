/**
 * The one place a scout `AgentSession` is created.
 *
 * Everything here is a translation between the registry's small contract (open, ask, file, dispose)
 * and the pi SDK. The interesting choices, all made here rather than by a caller:
 *
 *   - **The caller's model and runtime.** `ctx.model` with `ctx.modelRegistry` means a scout
 *     authenticates exactly as the thread that asked, with no second credential path. No
 *     `updateModel`: a model switch drops the cache the whole design exists to keep.
 *   - **Read-only tools.** read, grep, find, ls. No bash (which reaches the network and the host),
 *     no edit or write (a scout answers questions; it does not change the code under study).
 *   - **The scout skills, and nothing else.** A resource loader with extensions and context files
 *     off: loading this extension inside its own scout would recurse, and the report contract the
 *     session opens with is the skill's, restated once in the first message.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import {
	type AgentSession,
	type ExtensionContext,
	type ModelRuntime,
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ScoutAdapter, ScoutConversation } from "./scout-registry.ts";

/** Read-only by construction: a question is answered by reading. */
export const SCOUT_TOOLS = ["read", "grep", "find", "ls"] as const;

/** The skills a scout consults, resolved from the agent dir; absent ones are simply not loaded. */
const SCOUT_SKILLS = ["codebase-scout", "library-source"] as const;

/** Every session opens with this: the report shape comes from codebase-scout. */
export const REPORT_CONTRACT = `You are a codebase scout. Answer the question in the user's message by reading the checkout at your working directory.

Reply with the scout report, and nothing else:

answer
<the finding, direct, one or two sentences, no preamble>

findings
<one line per finding: a stable id (F1, F2...), one falsifiable claim, a path:line anchor, and a status of VERIFIED | INFERRED | STALE | UNVERIFIED. At most 30.>

gaps
<at most 10: what you could not settle, why, and the probe that would settle it. Write none when there are none.>

blockers
<at most 5, each with who resolves it. Write none when there are none.>

Hard limits: 800 words, 120 lines. Pointers only. No file contents, no grep output, no directory listings, no diffs, no narration, no restated task. A claim with no anchor is UNVERIFIED; a finding you could not produce is a gap, never an invented one.`;

/** The first message of a conversation: where the code is, and what to hand back. */
export const openingMessage = (repo: string, dir: string): string =>
	`Repository: ${repo}\nCheckout: ${dir}\n\n${REPORT_CONTRACT}`;

/** The calling thread's context, read once per conversation. */
export type ScoutModelSource = Pick<ExtensionContext, "model" | "modelRegistry">;

export type AgentAdapterOptions = {
	/** The calling thread's context; its model is read once per conversation. */
	source: ScoutModelSource;
	thinkingLevel?: ThinkingLevel;
	/** Overrides the source's model. */
	model?: Model<any>;
	/** Where scout session files live. */
	sessionsDir: string;
	/** Overridable for tests. */
	create?: typeof createAgentSession;
	agentDir?: string;
};

/** Reopen the recorded conversation, or start a new one in the scout sessions dir. */
const sessionManagerFor = (dir: string, sessionFile: string | undefined, sessionsDir: string): SessionManager => {
	if (sessionFile && existsSync(sessionFile)) return SessionManager.open(sessionFile, sessionsDir, dir);
	return SessionManager.create(dir, sessionsDir);
};

const loaderFor = (dir: string, agentDir: string): DefaultResourceLoader => {
	const skillsDir = join(agentDir, "skills");
	return new DefaultResourceLoader({
		cwd: dir,
		agentDir,
		noExtensions: true,
		noThemes: true,
		noContextFiles: true,
		noPromptTemplates: true,
		additionalSkillPaths: SCOUT_SKILLS.map((name) => join(skillsDir, name)).filter((path) => existsSync(path)),
	});
};

const requireModel = (source: ScoutModelSource): Model<any> => {
	if (!source.model) throw new Error("repo_scout needs a current model; select one first");
	return source.model;
};

/**
 * The `ModelRegistry` an extension sees is a facade around the `ModelRuntime` `createAgentSession`
 * wants. The runtime is the facade's only field, and it is a field on every pi that ships
 * `ModelRegistry`, but the facade does not declare it, so this is the one cast in the file.
 */
const runtimeOf = (source: ScoutModelSource): ModelRuntime =>
	(source.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;

const lastText = (session: AgentSession): string | undefined => {
	const text = session.getLastAssistantText();
	return text && text.trim() ? text.trim() : undefined;
};

export const createAgentAdapter = (options: AgentAdapterOptions): ScoutAdapter => {
	const create = options.create ?? createAgentSession;
	const agentDir = options.agentDir ?? getAgentDir();

	return {
		async open(repo: string, dir: string, sessionFile: string | undefined): Promise<ScoutConversation> {
			if (sessionFile) await mkdir(dirname(sessionFile), { recursive: true });
			const loader = loaderFor(dir, agentDir);
			await loader.reload();
			const { session }: { session: AgentSession } = await create({
				cwd: dir,
				model: options.model ?? requireModel(options.source),
				thinkingLevel: options.thinkingLevel ?? "medium",
				modelRuntime: runtimeOf(options.source),
				sessionManager: sessionManagerFor(dir, sessionFile, options.sessionsDir),
				resourceLoader: loader,
				tools: [...SCOUT_TOOLS],
			});

			// A replayed conversation already holds the opening contract and the earlier crawl.
			const replaying = Boolean(sessionFile && existsSync(sessionFile));
			let opening = !replaying;
			let fresh = !replaying;
			return {
				async ask(question: string): Promise<string> {
					const message = opening ? `${openingMessage(repo, dir)}\n\nQuestion:\n${question}` : question;
					opening = false;
					await session.prompt(message);
					fresh = false;
					const text = lastText(session);
					if (!text) throw new Error("the scout returned no text; the turn may have been cut off");
					return text;
				},
				sessionFile(): string | undefined {
					return session.sessionFile;
				},
				fresh(): boolean {
					return fresh;
				},
				dispose(): void {
					session.dispose();
				},
			};
		},
	};
};
