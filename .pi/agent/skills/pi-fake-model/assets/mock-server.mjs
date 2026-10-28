#!/usr/bin/env node
/**
 * Zero-dependency OpenAI Chat Completions mock for developing pi extensions.
 *
 *   node server.mjs --port 8787 --script script.json --log requests.jsonl
 *
 * Serves POST /v1/chat/completions (streaming SSE + non-streaming) and
 * GET /v1/models. Every request is appended to the log file so a test can
 * assert on the wire payload a pi extension produced.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
	args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const port = Number(args.get("port") ?? 8787);
const scriptPath = args.get("script") ?? null;
const logPath = args.get("log") ?? null;
const forcedStatus = args.get("fail") ? Number(args.get("fail")) : null;
const chunkDelayMs = Number(args.get("chunk-delay") ?? 0);

const script = scriptPath
	? JSON.parse(fs.readFileSync(scriptPath, "utf8"))
	: { rules: [], default: { text: "Mock reply." } };

if (logPath) fs.writeFileSync(logPath, "");

function logRequest(entry) {
	if (!logPath) return;
	fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((part) => part.type === "text" || part.type === "input_text")
			.map((part) => part.text ?? "")
			.join("\n");
	}
	return "";
}

function pickReply(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const haystack = messages.map(textOf).join("\n");
	for (const rule of script.rules ?? []) {
		if (new RegExp(rule.match, "i").test(haystack)) {
			return { ...script.default, ...rule };
		}
	}
	if (script.default?.whenTools && body.tools?.length) {
		return script.default.whenTools;
	}
	return script.default ?? { text: "Mock reply." };
}

function estimateTokens(text) {
	return Math.max(1, Math.ceil(text.length / 4));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(res, payload) {
	res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunkBase(body, id) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: body.model ?? "mock-1",
	};
}

async function handleCompletions(req, res, body) {
	const id = `chatcmpl-mock-${Date.now()}`;
	const reply = pickReply(body);
	const promptText = (body.messages ?? []).map(textOf).join("\n");
	const promptTokens = estimateTokens(promptText);

	if (forcedStatus) {
		const message =
			forcedStatus === 429
				? "mock: rate limit exceeded, retry later"
				: forcedStatus === 400
					? "mock: context_length_exceeded (forced)"
					: `mock: forced HTTP ${forcedStatus}`;
		res.writeHead(forcedStatus, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message, type: "mock_error", code: null } }));
		return;
	}

	if (!body.stream) {
		const toolCalls = reply.toolCall
			? [
					{
						id: reply.toolCall.id ?? "call_mock_1",
						type: "function",
						function: {
							name: reply.toolCall.name,
							arguments: JSON.stringify(reply.toolCall.arguments ?? {}),
						},
					},
				]
			: undefined;
		const content = toolCalls ? null : (reply.text ?? "");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				id,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: body.model ?? "mock-1",
				choices: [
					{
						index: 0,
						message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
						finish_reason: toolCalls ? "tool_calls" : "stop",
					},
				],
				usage: {
					prompt_tokens: promptTokens,
					completion_tokens: estimateTokens(reply.text ?? ""),
					total_tokens: promptTokens + estimateTokens(reply.text ?? ""),
				},
			}),
		);
		return;
	}

	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	let closed = false;
	req.on("close", () => {
		closed = true;
	});

	sse(res, { ...chunkBase(body, id), choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });

	if (reply.thinking) {
		for (const part of String(reply.thinking).match(/[\s\S]{1,16}/g) ?? []) {
			if (closed) return;
			sse(res, {
				...chunkBase(body, id),
				choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }],
			});
			if (chunkDelayMs) await sleep(chunkDelayMs);
		}
	}

	if (reply.toolCall) {
		const callId = reply.toolCall.id ?? "call_mock_1";
		const json = JSON.stringify(reply.toolCall.arguments ?? {});
		sse(res, {
			...chunkBase(body, id),
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: callId, type: "function", function: { name: reply.toolCall.name, arguments: "" } },
						],
					},
					finish_reason: null,
				},
			],
		});
		for (const part of json.match(/[\s\S]{1,12}/g) ?? []) {
			if (closed) return;
			sse(res, {
				...chunkBase(body, id),
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] }, finish_reason: null },
				],
			});
			if (chunkDelayMs) await sleep(chunkDelayMs);
		}
		sse(res, { ...chunkBase(body, id), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	} else {
		for (const part of String(reply.text ?? "").match(/[\s\S]{1,16}/g) ?? []) {
			if (closed) return;
			sse(res, { ...chunkBase(body, id), choices: [{ index: 0, delta: { content: part }, finish_reason: null }] });
			if (chunkDelayMs) await sleep(chunkDelayMs);
		}
		sse(res, { ...chunkBase(body, id), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	}

	if (body.stream_options?.include_usage !== false) {
		const completionTokens = estimateTokens(reply.text ?? "");
		sse(res, {
			...chunkBase(body, id),
			choices: [],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
				prompt_tokens_details: { cached_tokens: 0 },
				completion_tokens_details: { reasoning_tokens: 0 },
			},
		});
	}

	res.write("data: [DONE]\n\n");
	res.end();
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

	if (req.method === "GET" && url.pathname === "/v1/models") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				object: "list",
				data: [{ id: "mock-1", object: "model", created: 0, owned_by: "mock" }],
			}),
		);
		return;
	}

	if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `mock: no route for ${req.method} ${url.pathname}` } }));
		return;
	}

	let raw = "";
	req.on("data", (part) => {
		raw += part;
	});
	req.on("end", async () => {
		let body;
		try {
			body = JSON.parse(raw || "{}");
		} catch {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "mock: invalid JSON body" } }));
			return;
		}
		logRequest({
			at: new Date().toISOString(),
			path: url.pathname,
			authorization: req.headers.authorization ?? null,
			stream: Boolean(body.stream),
			model: body.model ?? null,
			toolCount: body.tools?.length ?? 0,
			messages: (body.messages ?? []).map((m) => ({ role: m.role, text: textOf(m).slice(0, 400) })),
		});
		try {
			await handleCompletions(req, res, body);
		} catch (error) {
			if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: String(error) } }));
		}
	});
});

server.listen(port, "127.0.0.1", () => {
	console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}/v1`, log: logPath, script: scriptPath }));
});
