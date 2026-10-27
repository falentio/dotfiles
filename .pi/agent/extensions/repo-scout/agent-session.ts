/**
 * The one place a scout `AgentSession` is created.
 *
 * Everything here is a translation between the registry's small contract (open, ask, file, abort,
 * dispose) and the pi SDK. The interesting choices, all made here rather than by a caller:
 *
 *   - **The caller's model and runtime.** The request names its model; the runtime comes from the
 *     calling thread's context, so a scout authenticates exactly as the thread that asked, with no
 *     second credential path.
 *   - **Read-only tools.** read, grep, find, ls. No bash (which reaches the network and the host),
 *     no edit or write (a scout answers questions; it does not change the code under study).
 *   - **The library skill, and nothing else.** A resource loader with extensions and context files
 *     off: loading this extension inside its own scout would recurse, and the report contract is
 *     restated inline, in the first message.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** The skill a scout consults, resolved from the agent dir; an absent one is simply not loaded. */
const SCOUT_SKILLS = ["library-source"] as const;

/** Every session opens with this. The contract is inline, so no skill has to supply it. */
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

export type ScoutModelSource = Pick<ExtensionContext, "model" | "modelRegistry">;

export type AgentAdapterOptions = {
	/** The calling thread's context, read once per conversation. */
	getSource: () => ScoutModelSource;
	/** Where scout session files live. */
	sessionsDir: string;
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
		async open(repo, dir, sessionFile, choice): Promise<ScoutConversation> {
			if (sessionFile) await mkdir(dirname(sessionFile), { recursive: true });
			const source = options.getSource();
			const loader = loaderFor(dir, agentDir);
			await loader.reload();
			const { session }: { session: AgentSession } = await create({
				cwd: dir,
				model: choice.model ?? requireModel(source),
				thinkingLevel: choice.thinkingLevel ?? "medium",
				modelRuntime: runtimeOf(source),
				sessionManager: sessionManagerFor(dir, sessionFile, options.sessionsDir),
				resourceLoader: loader,
				tools: [...SCOUT_TOOLS],
			});

			const replaying = Boolean(sessionFile && existsSync(sessionFile));
			let opening = !replaying;
			let fresh = !replaying;
			return {
				async ask(question: string, signal?: AbortSignal): Promise<string> {
					if (signal?.aborted) throw new Error("the scout question was aborted before it started");
					const message = opening ? `${openingMessage(repo, dir)}\n\nQuestion:\n${question}` : question;
					opening = false;
					const onAbort = () => {
						void session.abort();
					};
					signal?.addEventListener("abort", onAbort, { once: true });
					try {
						await session.prompt(message);
						fresh = false;
						const text = lastText(session);
						if (!text) throw new Error("the scout returned no text; the turn may have been cut off");
						return text;
					} catch (error) {
						fresh = false;
						if (signal?.aborted) throw new Error("the scout question was aborted");
						throw error;
					} finally {
						signal?.removeEventListener("abort", onAbort);
					}
				},
				sessionFile(): string | undefined {
					return session.sessionFile;
				},
				fresh(): boolean {
					return fresh;
				},
				abort(): void {
					void session.abort();
				},
				dispose(): void {
					session.dispose();
				},
			};
		},
	};
};
