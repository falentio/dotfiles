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
	const index = new Map<string, string>();
	let locked = 0;
	let released = 0;
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
		acquire: async () => {
			locked += 1;
			return async () => {
				released += 1;
			};
		},
		checkout: async ({ repo: identity, ref }) => ({
			dir: "/scratch/" + identity.key + (ref ? "@" + ref : ""),
			display: identity.display,
		}),
		refresh: async (dir) => {
			refreshed.push(dir);
			if (options.refreshFails) throw new Error("fetch refused");
		},
		adapter,
		sessionFileFor: async (key) => index.get(key),
		newSessionFile: (key) => `/sessions/${key}.jsonl`,
		rememberSession: async (key, file) => {
			index.set(key, file);
		},
		idleMs: 600_000,
		sweepMs: 200_000,
		turnMs: options.turnMs,
		now: clock.now,
		timers: clock.timers,
	});
	return { registry, conversations, opened, refreshed, index, advance, hasSweeper, locked: () => locked, released: () => released };
};

describe("ScoutRegistry", () => {
	it("opens one conversation per repo and reuses it", async () => {
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
		assert.deepEqual(registry.keys(), ["github.com/a/b", "github.com/c/d"]);
	});

	it("rebinds the one conversation when the model changes", async () => {
		const { registry, opened, conversations, refreshed } = build();
		await registry.run(request("a1", { model: model("a") }));
		await registry.run(request("b1", { model: model("b") }));
		assert.equal(registry.size(), 1, "a model switch does not add a conversation");
		assert.equal(opened.length, 2, "the change reopens the session on the new model");
		assert.equal(opened[1]?.file, "/sessions/github.com/a/b.jsonl", "the same transcript");
		assert.equal(conversations.get("github.com/a/b|a")?.disposed, true, "the old binding is disposed");
		await registry.run(request("b2", { model: model("b") }));
		assert.equal(opened.length, 2, "the same model stays bound");
		assert.deepEqual(conversations.get("github.com/a/b|b")?.questions, ["b1", "b2"]);
		assert.equal(refreshed.length, 1, "the shared tree is refreshed once, not on a rebind");
	});

	it("rebinds when the thinking level changes", async () => {
		const { registry, opened } = build();
		await registry.run(request("a1"));
		await registry.run(request("a2", { thinkingLevel: "high" }));
		assert.equal(opened.length, 2);
		assert.equal(registry.size(), 1);
	});

	it("holds the repo lock for the session and releases it on eviction", async () => {
		const { registry, advance, locked, released } = build();
		await registry.run(request("q"));
		assert.equal(locked(), 1);
		assert.equal(released(), 0);
		advance(600_001);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(released(), 1);
	});

	it("releases the lock when opening fails", async () => {
		let released = 0;
		const registry = new ScoutRegistry({
			acquire: async () => async () => {
				released += 1;
			},
			checkout: async () => {
				throw new Error("no clone");
			},
			refresh: async () => {},
			adapter: {
				async open() {
					throw new Error("unreachable");
				},
			},
			sessionFileFor: async () => undefined,
			newSessionFile: () => "/sessions/x.jsonl",
			rememberSession: async () => {},
			timers: { setInterval: () => 1, clearInterval: () => {} },
		});
		await assert.rejects(registry.run(request("q")), /no clone/);
		assert.equal(released, 1);
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
			acquire: async () => async () => {},
			checkout: async ({ repo: identity }) => ({ dir: "/scratch", display: identity.display }),
			refresh: async () => {},
			adapter,
			sessionFileFor: async () => undefined,
			newSessionFile: () => "/sessions/x.jsonl",
			rememberSession: async () => {},
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
		const index = new Map<string, string>();
		const { clock, advance } = fakeClock();
		const registry = new ScoutRegistry({
			acquire: async () => async () => {},
			checkout: async ({ repo: identity }) => ({ dir: "/scratch", display: identity.display }),
			refresh: async () => {},
			adapter,
			sessionFileFor: async (key) => index.get(key),
			newSessionFile: () => "/sessions/guessed.jsonl",
			rememberSession: async (key, file) => {
				index.set(key, file);
			},
			idleMs: 600_000,
			now: clock.now,
			timers: clock.timers,
		});
		await registry.run(request("q1"));
		advance(600_001);
		await registry.run(request("q2"));
		assert.deepEqual(opened, ["/sessions/guessed.jsonl", "/sessions/generated-by-pi.jsonl"]);
		assert.equal(index.get("github.com/a/b"), "/sessions/generated-by-pi.jsonl", "the written path is what survives");
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
		assert.equal(await registry.evict("github.com/a/b"), true);
		await assert.rejects(running, /evicted while this question ran/);
	});

	it("stops an open that is waiting for the lock when shutdown starts", async () => {
		let wait: AbortSignal | undefined;
		const registry = new ScoutRegistry({
			acquire: async (_request, signal) => {
				wait = signal;
				await new Promise<never>((_, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("lock wait aborted")), { once: true });
				});
				return async () => {};
			},
			checkout: async ({ repo: identity }) => ({ dir: "/scratch", display: identity.display }),
			refresh: async () => {},
			adapter: {
				async open() {
					throw new Error("unreachable");
				},
			},
			sessionFileFor: async () => undefined,
			newSessionFile: () => "/sessions/x.jsonl",
			rememberSession: async () => {},
			timers: { setInterval: () => 1, clearInterval: () => {} },
		});
		const running = registry.run(request("q"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const shutdown = registry.shutdown();
		await assert.rejects(running, /lock wait aborted/);
		await shutdown;
		assert.equal(wait?.aborted, true);
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
		let releaseLock: (() => void) | undefined;
		const lockGate = new Promise<void>((resolve) => {
			releaseLock = resolve;
		});
		const registry = new ScoutRegistry({
			acquire: async () => {
				await lockGate;
				return async () => {};
			},
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
			sessionFileFor: async () => undefined,
			newSessionFile: () => "/sessions/x.jsonl",
			rememberSession: async () => {},
			timers: { setInterval: () => 1, clearInterval: () => {} },
		});
		const running = registry.run(request("q"));
		await new Promise((resolve) => setTimeout(resolve, 0));
		const shutdown = registry.shutdown();
		release?.();
		releaseLock?.();
		await assert.rejects(running, /closed/);
		await shutdown;
		assert.equal(registry.size(), 0);
		assert.equal(disposed, true);
	});
});
