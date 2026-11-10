import { DEFAULT_WINDOW_MS } from "./config.ts";
import { ENDPOINTS, type EndpointId } from "./endpoints.ts";
import { invalid } from "./errors.ts";
import type { Lease, Limit, NonOk, Ok } from "./pool.ts";
import type { FetchParams, SearchParams } from "./params.ts";

export type SearchRequest = { readonly endpoint: "search"; readonly params: SearchParams };
export type FetchRequest = { readonly endpoint: "fetch"; readonly params: FetchParams };
export type EndpointRequest = SearchRequest | FetchRequest;

/** One attempt. `body` exists only beside `ok`, so a non-ok arm cannot carry a payload. */
export type Attempt =
	| { readonly outcome: Ok; readonly body: unknown }
	| { readonly outcome: NonOk; readonly body?: undefined };

export type Transport = (request: EndpointRequest, lease: Lease, signal: AbortSignal) => Promise<Attempt>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const nested = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const searchUrl = (params: SearchParams): string => {
	const url = new URL(ENDPOINTS.search.baseUrl());
	for (const [name, value] of Object.entries(params)) {
		if (value === undefined) continue;
		// The API takes publication years as four-character strings, and the schema types them as numbers.
		const wire = name.startsWith("pub_year_") ? String(value).padStart(4, "0") : String(value);
		url.searchParams.set(name, wire);
	}
	return url.toString();
};

/** The limit a 429 named: its body first, then its header, then the full default window. */
const windowOf = (body: unknown, headers: Headers): { windowMs: number; limit: Limit } => {
	const details = nested(nested(body, "error"), "details");
	const seconds = nested(details, "window_seconds");
	const header = Number(headers.get("retry-after"));
	const windowMs =
		typeof seconds === "number" && seconds > 0
			? seconds * 1000
			: Number.isFinite(header) && header > 0
				? header * 1000
				: DEFAULT_WINDOW_MS;
	const limit = nested(details, "limit");
	return {
		windowMs,
		limit: {
			limit: typeof limit === "number" ? limit : ENDPOINTS.search.perWindow,
			unit: typeof nested(details, "unit") === "string" ? String(nested(details, "unit")) : "minute",
			windowSeconds: Math.round(windowMs / 1000),
		},
	};
};

/**
 * Status to arm. `null` for a non-2xx the contract does not name (302 through a proxy, HTML from a
 * gateway, a 5xx), so the call loop decides: it backs off and rotates rather than spending the key.
 */
export const classify = (status: number, body: unknown, headers: Headers): Ok | NonOk | null => {
	if (status >= 200 && status < 300) return { kind: "ok" };
	if (status === 429) return { kind: "rate-limited", ...windowOf(body, headers) };
	if (status === 401) return { kind: "dead-key" };
	if (status === 402 || status === 403) {
		const walletUrl = nested(nested(body, "error"), "details");
		return { kind: "spent", walletUrl: isRecord(walletUrl) ? String(walletUrl.wallet_url ?? "") || null : null };
	}
	if (status === 400 || status === 422) return { kind: "invalid", error: invalid(status, body) };
	return null;
};

/**
 * The only reader of a raw key. A transport failure is an arm, not a throw, so the retry policy owns
 * the decision; only an abort leaves here as a rejection.
 */
export const send: Transport = async (request, lease, signal) => {
	const headers = { "X-API-Key": lease.account.key };
	let response: Response;
	try {
		const url = request.endpoint === "search" ? searchUrl(request.params) : ENDPOINTS.fetch.baseUrl();
		const body =
			request.endpoint === "search"
				? undefined
				: JSON.stringify(request.params satisfies FetchParams);
		response = await fetch(url, {
			method: request.endpoint === "search" ? "GET" : "POST",
			headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
			body,
			signal,
		});
	} catch (error) {
		if (signal.aborted) throw error;
		return { outcome: { kind: "transient" } };
	}
	const raw = await response.text();
	const payload = ((): unknown => {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	})();
	const outcome = classify(response.status, payload, response.headers);
	if (outcome === null) return { outcome: { kind: "transient" } };
	return outcome.kind === "ok" ? { outcome, body: payload } : { outcome };
};

export type { EndpointId };
