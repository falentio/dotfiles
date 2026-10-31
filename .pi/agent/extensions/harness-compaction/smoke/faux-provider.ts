/**
 * Faux provider for the smoke suite: three reads of big.txt, then DONE. Every request is written to
 * HARNESS_COMPACTION_LOG so the suite can inspect what pi actually sent, including the prune marker.
 */
import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { message, textOf } from "../../../test-support/faux-message.ts";

const READS = 3;
const SUMMARY_PROMPT = "context summarization assistant";

function logDir(): string {
	const dir = process.env.HARNESS_COMPACTION_LOG;
	if (!dir) throw new Error("HARNESS_COMPACTION_LOG must name the directory for request logs");
	return dir;
}

interface RequestContext {
	messages: Array<{ role: string; content: unknown }>;
}

let sequence = 0;
let reads = 0;
let nextCallId = 0;

const respond = (context: RequestContext) => {
	const n = ++sequence;
	const log = logDir();
	const request = context.messages.map((item) => `${item.role}:${JSON.stringify(item.content)}`).join("\n\n");
	fs.writeFileSync(path.join(log, `req-${String(n).padStart(3, "0")}.txt`), request);

	const summary = textOf(context.messages[0]?.content).includes(SUMMARY_PROMPT);
	fs.appendFileSync(path.join(log, "calls.log"), `${JSON.stringify({ n, kind: summary ? "summary" : "turn" })}\n`);
	if (summary) return message([{ type: "text", text: "[faux summary] earlier work happened." }]);

	reads++;
	if (reads <= READS) {
		const id = `faux-${nextCallId++}`;
		return message([{ type: "toolCall", id, name: "read", arguments: { path: "big.txt" } }], "toolUse");
	}
	return message([{ type: "text", text: "DONE" }]);
};

const MODEL = {
	id: "faux-1",
	name: "Faux 1",
	reasoning: false,
	contextWindow: Number(process.env.FAUX_WINDOW ?? 6000),
	maxTokens: 512,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export default function fauxModel(pi: ExtensionAPI) {
	const faux = registerFauxProvider({ provider: "faux", models: [MODEL] });
	faux.setResponses(Array.from({ length: 16 }, () => respond));
	pi.registerProvider("faux", {
		name: "Faux",
		baseUrl: "http://localhost:0",
		apiKey: "unused",
		api: faux.api,
		models: [MODEL],
	});
}
