import { describe, expect, it } from "bun:test";
import { envelope } from "../envelope.ts";
import { classify } from "../http.ts";

const headers = new Headers();

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

	it("keeps the limit null when the body named none, so the ceiling stays a local guess", () => {
		expect(classify(429, { error: { code: "RATE_LIMIT_EXCEEDED", details: { window_seconds: 600 } } }, headers)).toEqual({
			kind: "rate-limited",
			windowMs: 600_000,
			limit: null,
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

	it("grades an undeclared 4xx invalid, so a mistyped base URL fails without four attempts", () => {
		expect(classify(404, "Not Found", headers)).toMatchObject({ kind: "invalid", error: { status: 404 } });
	});

	it("answers null for everything it cannot place", () => {
		for (const status of [301, 304, 500, 502, 503]) expect(classify(status, "<html>", headers)).toBeNull();
	});
});

describe("the envelope", () => {
	it("puts the body in structuredContent, which is the value a script receives", () => {
		const body = { query: "q", results: [], total_results: 0, page: 0 };
		expect(envelope(body).structuredContent).toEqual(body);
	});

	it("forwards a field nobody declared", () => {
		const body = { results: [], errors: [], brand_new_field: { deep: true } };
		expect(envelope(body).structuredContent).toHaveProperty("brand_new_field.deep", true);
	});

	it("names a per-URL failure in the summary and keeps it in the body", () => {
		const result = envelope({ results: [], errors: [{ url: "https://x.test", error: "bot_blocked" }] });
		expect(result.content[0]?.text).toContain("bot_blocked");
		expect((result.structuredContent as { errors: unknown[] }).errors).toHaveLength(1);
	});
});

describe("the summary in content", () => {
	const text = (body: unknown) => envelope(body).content[0]?.text ?? "";

	it("counts results and names the query instead of dumping them", () => {
		expect(text({ query: "q", total_results: 12, results: [{ title: "A", url: "https://a.test" }] })).toBe(
			'12 results for "q"\n- A https://a.test',
		);
	});

	it("keeps a long result list to three lines and says how many it left out", () => {
		const results = Array.from({ length: 6 }, (_unused, index) => ({ title: `T${index}`, url: `https://x${index}.test` }));
		const shown = text({ results }).split("\n");
		expect(shown).toHaveLength(5);
		expect(shown.at(-1)).toBe("- and 3 more");
	});

	it("says no results rather than answering with an empty string", () => {
		expect(text({ query: "q", results: [], total_results: 0 })).toBe('0 results for "q"');
		expect(text({ nonsense: true })).toBe("no results");
	});

	it("still answers for a body that is not an object", () => {
		expect(text("plain")).toBe('"plain"');
	});
});
