#!/usr/bin/env node
/**
 * Drives a real pi session over RPC against the mock server:
 * a few turns, then a real /compact, all with a fake LLM.
 *
 *   node drive-rpc.mjs --turns 3 --compact
 */

import { spawn } from "node:child_process";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a.startsWith("--")) {
		const next = process.argv[i + 1];
		if (next && !next.startsWith("--")) {
			args.set(a.slice(2), next);
			i++;
		} else {
			args.set(a.slice(2), "true");
		}
	}
}

const turns = Number(args.get("turns") ?? 3);
const port = args.get("port") ?? process.env.MOCK_LLM_PORT ?? "8899";
const here = path.dirname(new URL(import.meta.url).pathname);
const pi = args.get("pi") ?? "pi";
const provider = args.get("provider") ?? "mock";
const model = args.get("model") ?? (provider === "mock" ? "mock-1" : "faux-1");
const extensions = (args.get("ext") ?? "mock-provider").split(",");

const prompts = [
	"Tell me a story about a lighthouse keeper.",
	"Continue the story, add a storm.",
	"Continue again, describe the morning.",
	"Continue once more, and end the story.",
];

const child = spawn(
	pi,
	[
		"--mode",
		"rpc",
		"--approve",
		"--session",
		path.join(process.env.MOCK_PROJECT ?? "/tmp/mock-project", "rpc.jsonl"),
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"-e",
		...extensions.map((name) => path.join(here, `${name}.ts`)),
		"--provider",
		provider,
		"--model",
		model,
		"--no-builtin-tools",
	],
	{
		cwd: process.env.MOCK_PROJECT ?? "/tmp/mock-project",
		env: { ...process.env, MOCK_LLM_PORT: port, PI_OFFLINE: "1", MOCK_CONTEXT_WINDOW: "8000" },
	},
);

const events = [];
let buffer = "";
const waiters = new Map();

function send(command) {
	child.stdin.write(JSON.stringify(command) + "\n");
}

function waitFor(predicate, timeoutMs = 60_000) {
	const hit = events.find(predicate);
	if (hit) return Promise.resolve(hit);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for event")), timeoutMs);
		waiters.set(predicate, (event) => {
			clearTimeout(timer);
			resolve(event);
		});
	});
}

child.stdout.on("data", (data) => {
	buffer += data.toString();
	let index;
	while ((index = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		events.push(event);
		for (const [predicate, resolve] of waiters) {
			if (predicate(event)) {
				waiters.delete(predicate);
				resolve(event);
			}
		}
	}
});

child.stderr.on("data", (data) => process.stderr.write(data));

const done = new Promise((resolve) => child.on("exit", resolve));

try {
	for (const prompt of prompts.slice(0, turns)) {
		const before = events.length;
		send({ id: `p-${events.length}`, type: "prompt", message: prompt });
		await waitFor((event) => event.type === "agent_end" && events.indexOf(event) >= before);
		console.log(`turn ok: ${prompt}`);
	}

	if (args.get("compact") === "true") {
		const before = events.length;
		send({ id: "compact-1", type: "compact", customInstructions: "Keep the storm." });
		const response = await waitFor(
			(event) => event.type === "response" && event.command === "compact" && events.indexOf(event) >= before,
		);
		const data = response.data ?? {};
		console.log("compact ok:", Boolean(response.success));
		if (!response.success) console.log("compact error:", JSON.stringify(response.error ?? response).slice(0, 300));
		console.log("summary:", String(data.summary ?? "").replace(/\n+/g, " ").slice(0, 160));
		console.log("tokensBefore:", data.tokensBefore, "-> estimatedTokensAfter:", data.estimatedTokensAfter);
	}
} finally {
	child.stdin.end();
	setTimeout(() => child.kill("SIGTERM"), 500);
	await done;
}
