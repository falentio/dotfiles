import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piCommand } from "../../../test-support/pi-install.mjs";
import { PROJECT_URL_HEADER, SESSION_ID_HEADER } from "../headers.ts";

const EXT_DIR = join(import.meta.dir, "..");
const PI = piCommand();
const SESSION_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

const requests: Array<Record<string, string>> = [];
const tempDirs: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let agentDir: string;

function chunk(model: string, delta: unknown, finishReason: string | null, usage?: unknown): string {
	const payload = {
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage === undefined ? {} : { usage }),
	};
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function body(model: string): string {
	return (
		chunk(model, { role: "assistant", content: "hi" }, null) +
		chunk(model, {}, "stop", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }) +
		"data: [DONE]\n\n"
	);
}

beforeAll(() => {
	agentDir = mkdtempSync(join(tmpdir(), "bandar-project-url-agent-"));
	tempDirs.push(agentDir);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const headers: Record<string, string> = {};
			request.headers.forEach((value, key) => {
				headers[key] = value;
			});
			requests.push(headers);
			const payload = (await request.json()) as { model?: string };
			return new Response(body(payload.model ?? "test-1"), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
});

afterAll(() => {
	server.stop(true);
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	requests.length = 0;
});

function makeRepo(remote?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "bandar-project-url-repo-"));
	tempDirs.push(dir);
	execFileSync("git", ["init", "--quiet"], { cwd: dir });
	if (remote !== undefined) execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
	return dir;
}

function runPi(cwd: string, provider = "bandar"): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			PI[0] as string,
			[
				...PI.slice(1),
				"-p",
				"--no-extensions",
				"--no-mcp",
				"--no-skills",
				"--no-context-files",
				"--no-session",
				"--session-id", SESSION_ID,
				"-e", join(EXT_DIR, "index.ts"),
				"-e", join(import.meta.dir, "http-provider.ts"),
				"--provider", provider,
				"--model", `${provider}-1`,
				"--api-key", "test",
				"hi",
			],
			{
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PROVIDER_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
				},
			},
		);
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (part: string) => (stderr += part));
		child.stdout.resume();
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out\n${stderr}`));
		}, 120_000);
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(`pi exited ${code ?? signal}\n${stderr}`));
		});
	});
}

function wireHeaders(): Record<string, string> {
	const last = requests.at(-1);
	if (last === undefined) throw new Error("pi sent no request");
	return last;
}

describe("bandar attribution headers on the wire", () => {
	it(
		"sends the origin remote as an https project url",
		async () => {
			await runPi(makeRepo("git@github.com:example/project.git"));
			const headers = wireHeaders();
			expect(headers[PROJECT_URL_HEADER]).toBe("https://github.com/example/project");
			expect(headers[SESSION_ID_HEADER]).toBe(SESSION_ID);
		},
		60_000,
	);

	it(
		"sends the session id when the repository has no remote",
		async () => {
			await runPi(makeRepo());
			const headers = wireHeaders();
			expect(headers[SESSION_ID_HEADER]).toBe(SESSION_ID);
			expect(headers[PROJECT_URL_HEADER]).toBeUndefined();
		},
		60_000,
	);

	it(
		"sends the session id outside a git repository",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "bandar-project-url-plain-"));
			tempDirs.push(dir);
			await runPi(dir);
			const headers = wireHeaders();
			expect(headers[SESSION_ID_HEADER]).toBe(SESSION_ID);
			expect(headers[PROJECT_URL_HEADER]).toBeUndefined();
		},
		60_000,
	);

	it(
		"keeps an https remote and drops the .git suffix",
		async () => {
			await runPi(makeRepo("https://github.com/example/r.git"));
			const headers = wireHeaders();
			expect(headers[PROJECT_URL_HEADER]).toBe("https://github.com/example/r");
			expect(headers[SESSION_ID_HEADER]).toBe(SESSION_ID);
		},
		60_000,
	);

	it(
		"sends neither header to a provider other than bandar",
		async () => {
			await runPi(makeRepo("git@github.com:example/project.git"), "other");
			const headers = wireHeaders();
			expect(headers[SESSION_ID_HEADER]).toBeUndefined();
			expect(headers[PROJECT_URL_HEADER]).toBeUndefined();
		},
		60_000,
	);
});
