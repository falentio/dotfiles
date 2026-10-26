/**
 * The registry's contract: one conversation per repo, one question at a time, evicted when idle,
 * reopened from the session file after an eviction. Every test drives a fake clock, so none wait.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScoutRegistry, type ScoutAdapter, type ScoutConversation } from "../scout-registry.ts";

/** A conversation that answers whatever the next queued answer says, and records what it saw. */
class FakeConversation implements ScoutConversation {
	readonly questions: string[] = [];
	disposed = false;
	private readonly answers: string[];
	private readonly pending: Array<{ question: string; release: () => void }> = [];
	private readonly manual: boolean;

	private readonly file: string | undefined;

	constructor(file: string | undefined, answers: string[], manual = false) {
		this.file = file;
		this.answers = answers;
		this.manual = manual;
	}

	ask(question: string): Promise<string> {
		this.questions.push(question);
		if (!this.manual) return Promise.resolve(this.answers.shift() ?? `answer to: ${question}`);
		return new Promise((resolve) => {
			this.pending.push({ question, release: () => resolve(this.answers.shift() ?? "released") });
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

const build = (options: { answers?: Record<string, string[]>; manual?: boolean } = {}) => {
	const conversations = new Map<string, FakeConversation>();
	const opened: Array<{ repo: string; dir: string; file: string | undefined }> = [];
	const evicted: string[] = [];
	const { clock, advance, hasSweeper } = fakeClock();
	const adapter: ScoutAdapter = {
		async open(repo, dir, sessionFile) {
			opened.push({ repo, dir, file: sessionFile });
			const conversation = new FakeConversation(sessionFile, options.answers?.[repo] ?? [], options.manual ?? false);
			conversations.set(repo, conversation);
			return conversation;
		},
	};
	const registry = new ScoutRegistry({
		prepare: async (key) => ({ dir: `/scratch/${key}`, display: key }),
		adapter,
		sessionFileFor: (key) => `/sessions/${key}.jsonl`,
		idleMs: 600_000,
		sweepMs: 200_000,
		now: clock.now,
		timers: clock.timers,
		onEvict: (key) => evicted.push(key),
	});
	return { registry, conversations, opened, evicted, advance, hasSweeper };
};

describe("ScoutRegistry", () => {
	it("opens one conversation per repo and reuses it", async () => {
		const { registry, opened } = build();
		await registry.run("github.com/a/b", "first");
		await registry.run("github.com/a/b", "second");
		assert.equal(opened.length, 1);
		assert.equal(registry.size(), 1);
	});

	it("keeps sessions for different repos apart", async () => {
		const { registry, opened } = build();
		await registry.run("github.com/a/b", "q1");
		await registry.run("github.com/c/d", "q2");
		assert.equal(opened.length, 2);
		assert.deepEqual(registry.keys(), ["github.com/a/b", "github.com/c/d"]);
	});

	it("serializes questions for one repo, in order", async () => {
		const { registry, conversations } = build({ manual: true });
		const first = registry.run("github.com/a/b", "one");
		const second = registry.run("github.com/a/b", "two");
		await new Promise((resolve) => setTimeout(resolve, 0));
		const conversation = conversations.get("github.com/a/b")!;
		assert.deepEqual(conversation.questions, ["one"]);
		assert.equal(registry.isBusy("github.com/a/b"), true);
		conversation.releaseAll();
		assert.equal((await first).report, "released");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(conversation.questions, ["one", "two"]);
		conversation.releaseAll();
		assert.equal((await second).report, "released");
		assert.equal(registry.isBusy("github.com/a/b"), false);
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
			prepare: async (key) => ({ dir: "/scratch", display: key }),
			adapter,
			sessionFileFor: () => "/sessions/x.jsonl",
			idleMs: 600_000,
			timers: { setInterval: () => 1, clearInterval: () => {} },
		});
		await assert.rejects(registry.run("github.com/a/b", "q"), /boom/);
		assert.equal((await registry.run("github.com/a/b", "again")).report, "recovered");
		assert.equal(registry.size(), 1);
	});

	it("evicts a session after the idle window", async () => {
		const { registry, advance, evicted, conversations } = build();
		await registry.run("github.com/a/b", "q");
		advance(400_000);
		assert.equal(registry.size(), 1, "do not evict before the window");
		advance(200_001);
		assert.equal(registry.size(), 0);
		assert.deepEqual(evicted, ["github.com/a/b"]);
		assert.equal(conversations.get("github.com/a/b")?.disposed, true);
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
			prepare: async (key) => ({ dir: "/scratch", display: key }),
			adapter,
			sessionFileFor: () => "/sessions/guessed.jsonl",
			idleMs: 600_000,
			now: clock.now,
			timers: clock.timers,
		});
		await registry.run("github.com/a/b", "q1");
		advance(600_001);
		await registry.run("github.com/a/b", "q2");
		assert.deepEqual(opened, ["/sessions/guessed.jsonl", "/sessions/generated-by-pi.jsonl"]);
	});

	it("does not evict while a question is in flight", async () => {
		const { registry, advance, conversations } = build({ manual: true });
		const running = registry.run("github.com/a/b", "slow");
		await new Promise((resolve) => setTimeout(resolve, 0));
		advance(3_000_000);
		assert.equal(registry.size(), 1);
		conversations.get("github.com/a/b")!.releaseAll();
		await running;
		advance(600_001);
		assert.equal(registry.size(), 0);
	});

	it("shutdown disposes everything and stops the sweeper", async () => {
		const { registry, evicted, hasSweeper } = build();
		await registry.run("github.com/a/b", "q");
		await registry.run("github.com/c/d", "q");
		assert.equal(hasSweeper(), true);
		await registry.shutdown();
		assert.equal(registry.size(), 0);
		assert.equal(hasSweeper(), false);
		assert.equal(evicted.length, 2);
		await assert.rejects(registry.run("github.com/a/b", "q"), /closed/);
	});
});