/**
 * The registry's contract: one conversation per repo, ref, model, and thinking level, one question
 * at a time, evicted when idle, reopened from the session file after an eviction. Every test drives
 * a fake clock, so none wait.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { RepoIdentity } from "../repo-id.ts";
import {
	ScoutRegistry,
	type ScoutAdapter,
	type ScoutConversation,
	type ScoutRequest,
	type ScoutThinking,
} from "../scout-registry.ts";

const model = (id: string): Model<any> => ({ provider: "p", id }) as Model<any>;

const repo = (key = "github.com/a/b"): RepoIdentity => ({
	key,
	source: "https://" + key,
	display: key,
	kind: "remote",
	slug: key.replace(/[^a-z0-9]+/g, "-"),
});

const request = (question: string, overrides: Partial<ScoutRequest> = {}): ScoutRequest => ({
	repo: repo(),
	model: model("m"),
	thinkingLevel: "medium" as ScoutThinking,
	question,
	...overrides,
});

/** A conversation that answers whatever the next queued answer says, and records what it saw. */
class FakeConversation implements ScoutConversation {
	readonly questions: string[] = [];
	aborted = false;
	disposed = false;
	private readonly answers: string[];
	private readonly pending: Array<{ question: string; release: () => void }> = [];
	private readonly manual: boolean;
	private readonly file: string | undefined;
	private readonly hangs: boolean;

	constructor(file: string | undefined, answers: string[], manual = false, hangs = false) {
		this.file = file;
		this.answers = answers;
		this.manual = manual;
		this.hangs = hangs;
	}

	ask(question: string, signal?: AbortSignal): Promise<string> {
		this.questions.push(question);
		if (this.hangs) return new Promise(() => {});
		if (!this.manual) return Promise.resolve(this.answers.shift() ?? `answer to: ${question}`);
		return new Promise((resolve, reject) => {
			const onAbort = () => reject(new Error("aborted"));
			signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.push({
				question,
				release: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve(this.answers.shift() ?? "released");
				},
			});
		});
	}

	releaseAll(): void {
		for (const entry of this.pending.splice(0)) entry.release();
	}

	sessionFile(): string | undefined {
		return this.file;
	}

	fresh(): boolean {
		return false;
	}

	abort(): void {
		this.aborted = true;
	}

	dispose(): void {
		this.disposed = true;
	}
}

const fakeClock = () => {
	let now = 0;
	let tick: (() => void) | undefined;
	return {
		clock: {
			now: () => now,
			timers: {
				setInterval: (fn: () => void) => {
					tick = fn;
					return 1;
				},
				clearInterval: () => {
					tick = undefined;
				},
			},
		},
		advance: (ms: number) => {
			now += ms;
			if (tick) tick();
		},
		hasSweeper: () => tick !== undefined,
	};
};

const build = (
	options: { answers?: Record<string, string[]>; manual?: boolean; hangs?: boolean; turnMs?: number; refreshFails?: boolean } = {},
) => {
	const conversations = new Map<string, FakeConversation>();
	const opened: Array<{ repo: string; dir: string; file: string | undefined; model: string }> = [];
	const refreshed: string[] = [];
	const { clock, advance, hasSweeper } = fakeClock();
	const adapter: ScoutAdapter = {
		async open(openedRepo, openedDir, sessionFile, choice) {
			opened.push({ repo: openedRepo, dir: openedDir, file: sessionFile, model: choice.model.id });
			const conversation = new FakeConversation(
				sessionFile,
				options.answers?.[openedRepo] ?? [],
				options.manual ?? false,
				options.hangs ?? false,
			);
			conversations.set(openedRepo + "|" + choice.model.id, conversation);
			return conversation;
		},
	};
	const registry = new ScoutRegistry({
		checkout: async ({ repo: identity, ref }) => ({
			dir: "/scratch/" + identity.key + (ref ? "@" + ref : ""),
			display: identity.display,
		}),
		refresh: async (dir) => {
			refreshed.push(dir);
			if (options.refreshFails) throw new Error("fetch refused");
		},
		adapter,
		sessionFileFor: (key) => `/sessions/${key}.jsonl`,
		idleMs: 600_000,
		sweepMs: 200_000,
		turnMs: options.turnMs,
		now: clock.now,
		timers: clock.timers,
	});
	return { registry, conversations, opened, refreshed, advance, hasSweeper };
};

describe("ScoutRegistry", () => {
	it("opens one conversation per request identity and reuses it", async () => {
		const { registry, opened } = build();
		await registry.run(request("first"));
		await registry.run(request("second"));
		assert.equal(opened.length, 1);
		assert.equal(registry.size(), 1);
	});

	it("keeps sessions for different repos apart", async () => {
		const { registry, opened } = build();
		await registry.run(request("q1"));
		await registry.run(request("q2", { repo: repo("github.com/c/d") }));
		assert.equal(opened.length, 2);
		assert.deepEqual(registry.keys(), ["github.com/a/b||p/m|medium", "github.com/c/d||p/m|medium"]);
	});

	it("gives each model its own conversation on one repo", async () => {
		const { registry, opened, conversations, refreshed } = build();
		await registry.run(request("a1", { model: model("a") }));
		await registry.run(request("b1", { model: model("b") }));
		assert.equal(opened.length, 2, "a model switch opens another conversation");
		await registry.run(request("b2", { model: model("b") }));
		assert.equal(opened.length, 2, "the second model keeps its own conversation");
		assert.deepEqual(conversations.get("github.com/a/b|b")?.questions, ["b1", "b2"]);
		assert.equal(refreshed.length, 1, "the shared tree is refreshed once, not under the live session");
	});

	it("gives each ref its own conversation", async () => {
		const { registry, opened } = build();
		await registry.run(request("q", { ref: "release/1.0" }));
		await registry.run(request("q", { ref: "release-1.0" }));
		assert.equal(opened.length, 2);
		assert.equal(new Set(registry.keys()).size, 2);
	});

	it("serializes questions for one conversation, in order", async () => {
		const { registry, conversations } = build({ manual: true });
		const first = registry.run(request("one"));
		const second = registry.run(request("two"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const conversation = conversations.get("github.com/a/b|m")!;
		assert.deepEqual(conversation.questions, ["one"]);
		assert.equal(registry.isBusy(request("")), true);
		conversation.releaseAll();
		assert.equal((await first).report, "released");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(conversation.questions, ["one", "two"]);
		conversation.releaseAll();
		assert.equal((await second).report, "released");
		assert.equal(registry.isBusy(request("")), false);
	});

	it("a failing question rejects its caller without poisoning the session", async () => {
		const adapter: ScoutAdapter = {
			async open() {
				let call = 0;
				return {
					ask: async () => {
						call += 1;
						if (call === 1) throw new Error("boom");
						return "recovered";
					},
					sessionFile: () => undefined,
					fresh: () => false,
					dispose: () => {},
				};
			},
		};
		const registry = new ScoutRegistry({
			checkout: async ({ repo: identity }) => ({ dir: "/scratch", display: identity.display }),
			refresh: async () => {},
			adapter,
			sessionFileFor: () => "/sessions/x.jsonl",
			idleMs: 600_000,
			timers: { setInterval: () => 1, clearInterval: () => {} },
		});
		await assert.rejects(registry.run(request("q")), /boom/);
		assert.equal((await registry.run(request("again"))).report, "recovered");
		assert.equal(registry.size(), 1);
	});

	it("reports a refresh failure instead of failing the question", async () => {
		const { registry } = build({ refreshFails: true });
		const result = await registry.run(request("q"));
		assert.match(result.warnings.join("\n"), /refresh failed: fetch refused/);
	});

	it("aborts the turn in flight when the caller's signal fires", async () => {
		const { registry } = build({ manual: true });
		const controller = new AbortController();
		const running = registry.run(request("slow"), controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		await assert.rejects(running, /aborted/);
	});

	it("rejects a pasted-abort call without asking", async () => {
		const { registry, conversations } = build();
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(registry.run(request("q"), controller.signal), /aborted/);
		assert.equal(conversations.size, 0, "no conversation is opened for an aborted call");
	});

	it("times a hung turn out and asks the conversation to abort", async () => {
		const { registry, conversations } = build({ hangs: true, turnMs: 30 });
		await assert.rejects(registry.run(request("stuck")), /timed out after 30 ms/);
		assert.equal(conversations.get("github.com/a/b|m")?.aborted, true);
	});

	it("evicts a session after the idle window", async () => {
		const { registry, advance, conversations } = build();
		await registry.run(request("q"));
		advance(400_000);
		assert.equal(registry.size(), 1, "do not evict before the window");
		advance(200_001);
		assert.equal(registry.size(), 0);
		assert.equal(conversations.get("github.com/a/b|m")?.disposed, true);
	});

	it("reopens the file pi actually wrote, not the name it was offered", async () => {
		// pi names the session file it creates, so the adapter reports a different path than the guess.
		const opened: Array<string | undefined> = [];
		const adapter: ScoutAdapter = {
			async open(_repo, _dir, sessionFile) {
				opened.push(sessionFile);
				const written = "/sessions/generated-by-pi.jsonl";
				return {
					ask: async () => "report",
					sessionFile: () => written,
					fresh: () => false,
					dispose: () => {},
				};
			},
		};
		const { clock, advance } = fakeClock();
		const registry = new ScoutRegistry({
			checkout: async ({ repo: identity }) => ({ dir: "/scratch", display: identity.display }),
			refresh: async () => {},
			adapter,
			sessionFileFor: () => "/sessions/guessed.jsonl",
			idleMs: 600_000,
			now: clock.now,
			timers: clock.timers,
		});
		await registry.run(request("q1"));
		advance(600_001);
		await registry.run(request("q2"));
		assert.deepEqual(opened, ["/sessions/guessed.jsonl", "/sessions/generated-by-pi.jsonl"]);
	});

	it("does not evict while a question is in flight", async () => {
		const { registry, advance, conversations } = build({ manual: true });
		const running = registry.run(request("slow"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		advance(3_000_000);
		assert.equal(registry.size(), 1);
		conversations.get("github.com/a/b|m")!.releaseAll();
		await running;
		advance(600_001);
		assert.equal(registry.size(), 0);
	});

	it("settles the running question when its session is evicted", async () => {
		const { registry } = build({ manual: true });
		const running = registry.run(request("slow"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(await registry.evict("github.com/a/b||p/m|medium"), true);
		await assert.rejects(running, /evicted while this question ran/);
	});

	it("shutdown disposes everything and stops the sweeper", async () => {
		const { registry, hasSweeper } = build();
		await registry.run(request("q"));
		await registry.run(request("q", { repo: repo("github.com/c/d") }));
		assert.equal(hasSweeper(), true);
		await registry.shutdown();
		assert.equal(registry.size(), 0);
		assert.equal(hasSweeper(), false);
		await assert.rejects(registry.run(request("q")), /closed/);
	});

	it("an open that finishes after shutdown is disposed, not inserted", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let disposed = false;
		const registry = new ScoutRegistry({
			checkout: async ({ repo: identity }) => {
				await gate;
				return { dir: "/scratch", display: identity.display };
			},
			refresh: async () => {},
			adapter: {
				async open() {
					return {
						ask: async () => "late",
						sessionFile: () => undefined,
						fresh: () => true,
						dispose: () => {
							disposed = true;
						},
					};
				},
			},
			sessionFileFor: () => "/sessions/x.jsonl",
			timers: { setInterval: () => 1, clearInterval: () => {} },
		});
		const running = registry.run(request("q"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const shutdown = registry.shutdown();
		release?.();
		await assert.rejects(running, /closed/);
		await shutdown;
		assert.equal(registry.size(), 0);
		assert.equal(disposed, true);
	});
});
