/**
 * The whole pipeline over a real `AgentSession` on a fake provider: the first question opens a
 * session in a scratch clone, the second continues it, and an evicted session is reopened from its
 * file. No credentials and no network beyond a local git repo.
 */

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
	// An origin that cannot be cloned: the pipeline must read this path, not go hunting for the remote.
	git(root, "remote", "add", "origin", "https://github.com/example/local-smoke.git");
	return root;
};

/** A provider that answers with a fixed report and records every prompt it was sent. */
const fakeProvider = () => {
	const prompts: string[] = [];
	const faux = fauxProvider({ models: [{ id: "scout-fake", name: "Fake scout" }] });
	// One scripted response per model call to come: open, continue, reopen.
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
		process.env.PI_SCOUT_HOME = state;

		const { faux, prompts } = fakeProvider();
		// The caller's registry, with the fake provider standing in for a real one.
		const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		// The facade the extension gets, backed by the fake runtime.
		const modelRegistry = new ModelRegistry(runtime);
		const source = { model: faux.getModel(), modelRegistry };

		const scratch = await mkdtemp(join(tmpdir(), "repo-scout-scratch-"));
		process.env.PI_SCOUT_SCRATCH = scratch;
		roots.push(scratch);
		let now = 0;
		let tick: (() => void) | undefined;
		const built = buildRegistry({ source: () => source, log: { info: () => {}, warn: () => {}, error: () => {} } });
		// The production checkout, lock, index, and adapter, with a clock the test owns.
		const registryFor = () =>
			new ScoutRegistry({
				acquire: (request) =>
					acquireLock({
						dir: join(locksDir(), digestKey(conversationKey(request)) + ".lock"),
						label: "smoke",
						waitMs: 5_000,
					}),
				checkout: checkoutFor,
				refresh: refreshCheckout,
				adapter: built.adapter,
				sessionFileFor: (key) => readSessionIndex(sessionsIndexDir(), key),
				newSessionFile: (key) => join(sessionsDir(), sessionFileName(key)),
				rememberSession: (key, file) => writeSessionIndex(sessionsIndexDir(), key, file),
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

		// The scout saw the opening message first, then the bare follow-up.
		assert.equal(prompts.length, 2);
		assert.match(prompts[0] ?? "", /^Repository: /);
		assert.match(prompts[0] ?? "", /Checkout: /);
		assert.match(prompts[0] ?? "", /what is exported\?$/);
		assert.equal(prompts[1], "and again?");

		// Idle past the window: evicted, then reopened from the same conversation file.
		now += 3_600_001;
		tick?.();
		assert.equal(registry.size(), 0);
		const third = await runRepoScout({ params: { repo, question: "back again?" }, registry, cwd: repo, choice });
		assert.match(third, /turn   continued/, "a reopened session continues the same conversation");
		assert.equal(prompts[2], "back again?", "the replayed conversation is not re-primed");
		const transcripts = readdirSync(sessionsDir()).filter((name) => name.endsWith(".jsonl"));
		assert.equal(transcripts.length, 1, "every turn recorded to one session file");
		assert.equal(identity.key, "github.com/example/local-smoke");
		const indexed = await readSessionIndex(sessionsIndexDir(), identity.key);
		assert.equal(indexed, join(sessionsDir(), transcripts[0]!), "the index names the file pi wrote");

		await registry.shutdown();
		assert.deepEqual(readdirSync(locksDir()), [], "shutdown releases the repo lock");

		// A fresh registry is what another pi process starts with: same state root, same index.
		const other = registryFor();
		const fourth = await runRepoScout({ params: { repo, question: "one more?" }, registry: other, cwd: repo, choice });
		assert.match(fourth, /turn   continued/, "the new registry continues the recorded transcript");
		assert.equal(prompts[3], "one more?", "and does not re-prime it");
		await other.shutdown();
	});
});
