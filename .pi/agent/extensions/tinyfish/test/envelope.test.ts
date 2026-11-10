import { describe, expect, it } from "bun:test";
import { classify } from "../http.ts";

const headers = new Headers();

/** The envelope `index.ts` registers: the API body JSON-serialized, with no response schema in between. */
const envelope = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

describe("classify", () => {
	it("accepts every 2xx", () => {
		for (const status of [200, 201, 204]) expect(classify(status, null, headers)).toEqual({ kind: "ok" });
	});

	it("takes the 429 window from the body", () => {
		const body = { error: { code: "RATE_LIMIT_EXCEEDED", details: { limit: 30, unit: "minute", window_seconds: 12 } } };
		expect(classify(429, body, headers)).toEqual({
			kind: "rate-limited",
			windowMs: 12_000,
			limit: { limit: 30, unit: "minute", windowSeconds: 12 },
		});
	});

	it("falls to Retry-After when the body names no window", () => {
		const withHeader = new Headers({ "retry-after": "9" });
		expect(classify(429, { error: { code: "RATE_LIMIT_EXCEEDED" } }, withHeader)).toMatchObject({ windowMs: 9_000 });
	});

	it("falls to one minute when nothing names a window", () => {
		expect(classify(429, null, headers)).toMatchObject({ windowMs: 60_000 });
	});

	it("retires a 401 key", () => {
		expect(classify(401, { error: { code: "INVALID_API_KEY" } }, headers)).toEqual({ kind: "dead-key" });
	});

	it("carries the wallet url of a 402 or 403, and null without one", () => {
		const body = { error: { code: "INSUFFICIENT_CREDITS", details: { wallet_url: "https://wallet" } } };
		expect(classify(402, body, headers)).toEqual({ kind: "spent", walletUrl: "https://wallet" });
		expect(classify(403, { error: { code: "FORBIDDEN" } }, headers)).toEqual({ kind: "spent", walletUrl: null });
	});

	it("reports a 400 and a 422 as invalid, carrying the body", () => {
		const outcome = classify(422, { error: { code: "UNPROCESSABLE" } }, headers);
		expect(outcome).toMatchObject({ kind: "invalid", error: { type: "tinyfish-invalid", status: 422 } });
		expect(classify(400, null, headers)).toMatchObject({ kind: "invalid" });
	});

	it("answers null for everything it cannot place", () => {
		for (const status of [301, 500, 502, 503, 418]) expect(classify(status, "<html>", headers)).toBeNull();
	});
});

describe("the envelope", () => {
	it("is the MCP shape, one text part holding the JSON body", () => {
		const result = envelope({ query: "q", results: [], total_results: 0, page: 0 });
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ query: "q", results: [], total_results: 0, page: 0 });
	});

	it("forwards a field nobody declared", () => {
		const body = { results: [], errors: [], brand_new_field: { deep: true } };
		expect(JSON.parse(envelope(body).content[0]?.text ?? "")).toHaveProperty("brand_new_field.deep", true);
	});

	it("keeps a per-URL error array inside the text, not beside it", () => {
		const text = envelope({ results: [], errors: [{ url: "https://x.test", error: "bot_blocked" }] }).content[0]?.text ?? "";
		expect(JSON.parse(text).errors).toEqual([{ url: "https://x.test", error: "bot_blocked" }]);
	});
});
