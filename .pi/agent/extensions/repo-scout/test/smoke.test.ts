import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { conversationKey, ScoutRegistry } from "../scout-registry.ts";
import { buildRegistry, checkoutFor, identifyRepo, locksDir, runRepoScout, sessionsDir, sessionsIndexDir } from "../tools.ts";
import { refreshCheckout } from "../checkout.ts";
import { sessionFileName } from "../repo-id.ts";
import { acquireLock } from "../state-lock.ts";
import { digestKey, readSessionIndex, writeSessionIndex } from "../session-index.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

const makeRepo = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "repo-scout-smoke-"));
	roots.push(root);
	git(root, "init", "--quiet", "--initial-branch", "main");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	await writeFile(join(root, "index.ts"), "export const answer = 42;\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "first");
	git(root, "remote", "add", "origin", "https://github.com/example/local-smoke.git");
	return root;
};

const fakeProvider = () => {
	const prompts: string[] = [];
	const faux = fauxProvider({ models: [{ id: "scout-fake", name: "Fake scout" }] });
	const respond = (context: { messages: Array<{ content: unknown }> }) => {
		const last = context.messages[context.messages.length - 1];
		const text =
			typeof last?.content === "string"
				? last.content
				: Array.isArray(last?.content)
					? last.content.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("")
					: "";
		prompts.push(text);
		return fauxAssistantMessage([fauxText(`answer\nseen: ${text.slice(0, 60)}`)]);
	};
	faux.setResponses([respond, respond, respond, respond]);
	return { faux, prompts };
};

describe("repo_scout over a real AgentSession", () => {
	it("opens once, continues the conversation, and reopens it after eviction", async () => {
		const repo = await makeRepo();
		const state = await mkdtemp(join(tmpdir(), "repo-scout-state-"));
		roots.push(state);

		const { faux, prompts } = fakeProvider();
		const queuedBefore = faux.getPendingResponseCount();
		const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		const modelRegistry = new ModelRegistry(runtime);
		const source = { model: faux.getModel(), modelRegistry };

		let now = 0;
		let tick: (() => void) | undefined;
		const built = buildRegistry({ source: () => source, log: { info: () => {}, warn: () => {}, error: () => {} }, stateRoot: state });
		const registryFor = () =>
			new ScoutRegistry({
				acquire: (request) =>
					acquireLock({
						dir: join(locksDir(state), digestKey(conversationKey(request)) + ".lock"),
						label: "smoke",
						waitMs: 5_000,
					}),
				checkout: (request) => checkoutFor(request, state),
				refresh: refreshCheckout,
				adapter: built.adapter,
				sessionFileFor: (key) => readSessionIndex(sessionsIndexDir(state), key),
				newSessionFile: (key) => join(sessionsDir(state), sessionFileName(key)),
				rememberSession: (key, file) => writeSessionIndex(sessionsIndexDir(state), key, file),
				idleMs: 3_600_000,
				now: () => now,
				timers: {
					setInterval: (fn) => {
						tick = fn;
						return 1;
					},
					clearInterval: () => {
						tick = undefined;
					},
				},
			});
		const registry = registryFor();

		const identity = await identifyRepo(repo, repo);
		const choice = { model: faux.getModel(), modelRegistry };
		const first = await runRepoScout({
			params: { repo, question: "what is exported?" },
			registry,
			cwd: repo,
			choice,
		});
		assert.match(first, /^answer/m);
		assert.match(first, /\bsha    [0-9a-f]{7,12}/);
		assert.match(first, /turn   opened/);
		assert.equal(registry.size(), 1);

		const second = await runRepoScout({ params: { repo, question: "and again?" }, registry, cwd: repo, choice });
		assert.match(second, /turn   continued/);
		assert.equal(registry.size(), 1);

		assert.equal(prompts.length, 2);
		assert.match(prompts[0] ?? "", /^Repository: /);
		assert.match(prompts[0] ?? "", /Checkout: /);
		assert.match(prompts[0] ?? "", /what is exported\?$/);
		assert.equal(prompts[1], "and again?");

		now += 3_600_001;
		tick?.();
		assert.equal(registry.size(), 0);
		const third = await runRepoScout({ params: { repo, question: "back again?" }, registry, cwd: repo, choice });
		assert.match(third, /turn   continued/, "a reopened session continues the same conversation");
		assert.equal(prompts[2], "back again?", "the replayed conversation is not re-primed");
		const transcripts = readdirSync(sessionsDir(state)).filter((name) => name.endsWith(".jsonl"));
		assert.equal(transcripts.length, 1, "every turn recorded to one session file");
		assert.equal(identity.key, "github.com/example/local-smoke");
		const indexed = await readSessionIndex(sessionsIndexDir(state), identity.key);
		assert.equal(indexed, join(sessionsDir(state), transcripts[0]!), "the index names the file pi wrote");

		await registry.shutdown();
		assert.deepEqual(readdirSync(locksDir(state)), [], "shutdown releases the repo lock");

		const other = registryFor();
		const fourth = await runRepoScout({ params: { repo, question: "one more?" }, registry: other, cwd: repo, choice });
		assert.match(fourth, /turn   continued/, "the new registry continues the recorded transcript");
		assert.equal(prompts[3], "one more?", "and does not re-prime it");
		assert.equal(queuedBefore - faux.getPendingResponseCount(), 4, "four turns consumed four queued responses");
		await other.shutdown();
	});
});
