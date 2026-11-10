import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { piCommand } from "../../../test-support/pi-install.mjs";
import { json, startStub, type Stub } from "./stub.ts";

const EXT_DIR = join(import.meta.dir, "..");
const PI = piCommand();

let stub: Stub;
let dir: string;
let agentDir: string;

beforeAll(() => {
	stub = startStub();
	dir = mkdtempSync(join(tmpdir(), "tinyfish-smoke-"));
	agentDir = mkdtempSync(join(tmpdir(), "tinyfish-smoke-agent-"));
	// Providers stay real: bandar is the one that answers here.
	for (const file of ["models.json", "auth.json"]) copyFileSync(join(homedir(), ".pi", "agent", file), join(agentDir, file));
	writeFileSync(
		join(dir, "accounts.json"),
		JSON.stringify({ accounts: [{ id: "a1", label: "smoke", key: "smoke-key", weight: 1 }], cursor: null }),
		{ mode: 0o600 },
	);
});

afterAll(() => {
	stub.stop();
	rmSync(dir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

function runPi(): Promise<{ code: number | null; out: string; err: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			PI[0] as string,
			[
				...PI.slice(1),
				"-p",
				"--no-mcp",
				"--no-skills",
				"--no-context-files",
				"--no-session",
				"--thinking",
				"off",
				"-e", join(EXT_DIR, "index.ts"),
				// codemode ships as an extension, so --no-extensions would remove the tools namespace itself.
				"--tools", "+codemode",
				`In one codemode script call tools.tinyfish_search({ query: "smoke" }) and tools.tinyfish_fetch_content({ urls: ["https://x.test"], format: "markdown", links: false, image_links: false, page_metadata: false }), then reply with only their text.`,
			],
			{
				cwd: dir,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					TINYFISH_SEARCH_BASE_URL: stub.searchBase,
					TINYFISH_FETCH_BASE_URL: stub.fetchBase,
					TINYFISH_ACCOUNTS_FILE: join(dir, "accounts.json"),
					PI_CODING_AGENT_DIR: agentDir,
					PI_OFFLINE: "1",
				},
			},
		);
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (part: string) => (out += part));
		child.stderr.on("data", (part: string) => (err += part));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pi timed out\nSTDOUT:${out}\nSTDERR:${err}`));
		}, 90_000);
		child.on("error", reject);
		child.on("exit", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

describe("the extension inside pi", () => {
	it(
		"registers both tools and serves them through the namespace",
		async () => {
			stub.script("smoke-key", "search", [
				json(200, { query: "smoke", results: [{ position: 1, site_name: "x", title: "t", snippet: "s", url: "https://x.test" }], total_results: 1, page: 0 }),
			]);
			const { code, out } = await runPi();
			expect(code).toBe(0);
			expect(out).toContain('"total_results":1');
			expect(stub.seen).toContain("smoke-key");
			expect(stub.hit("smoke-key", "fetch")).toBeGreaterThan(0);
		},
		{ timeout: 120_000 },
	);
});
