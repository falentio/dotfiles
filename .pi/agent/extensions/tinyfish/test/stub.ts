/**
 * A real server, one base path per endpoint, so the suite exercises the actual URL, header, status,
 * and body the extension puts on the wire. It records every key it saw and answers from a script.
 */

export type Endpoint = "search" | "fetch";

type Scripted = { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> };

export interface Stub {
	readonly searchBase: string;
	readonly fetchBase: string;
	/** The X-API-Key of every request, in arrival order. */
	readonly seen: string[];
	/** Responses sent per key and endpoint. */
	hit(key: string, endpoint: Endpoint): number;
	/** Queue answers for one key on one endpoint; the last answer repeats once the queue runs out. */
	script(key: string, endpoint: Endpoint, answers: readonly Scripted[]): void;
	delay(endpoint: Endpoint, ms: number): void;
	stop(): void;
}

export const okBody = (endpoint: Endpoint): unknown =>
	endpoint === "search"
		? { query: "q", results: [], total_results: 0, page: 0 }
		: { results: [], errors: [] };

export const json = (status: number, body?: unknown, headers?: Record<string, string>): Scripted => ({
	status,
	body,
	headers,
});

export function startStub(): Stub {
	const seen: string[] = [];
	const delivered = new Map<string, number>();
	const scripts = new Map<string, { answers: readonly Scripted[]; taken: number }>();
	const delays: Record<Endpoint, number> = { search: 0, fetch: 0 };

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const endpoint: Endpoint = url.pathname.startsWith("/fetch") ? "fetch" : "search";
			const key = request.headers.get("x-api-key") ?? "";
			const name = `${key} ${endpoint}`;
			seen.push(key);
			delivered.set(name, (delivered.get(name) ?? 0) + 1);
			if (delays[endpoint] > 0) await Bun.sleep(delays[endpoint]);
			const script = scripts.get(name);
			const answer = script === undefined ? undefined : script.answers[Math.min(script.taken, script.answers.length - 1)];
			if (script !== undefined) script.taken += 1;
			const settled = answer ?? { status: 200, body: okBody(endpoint) };
			return new Response(typeof settled.body === "string" ? settled.body : JSON.stringify(settled.body ?? null), {
				status: settled.status,
				headers: { "content-type": "application/json", ...settled.headers },
			});
		},
	});

	const origin = `http://127.0.0.1:${server.port}`;

	return {
		searchBase: `${origin}/search`,
		fetchBase: `${origin}/fetch`,
		seen,
		hit: (key, endpoint) => delivered.get(`${key} ${endpoint}`) ?? 0,
		script: (key, endpoint, answers) => void scripts.set(`${key} ${endpoint}`, { answers, taken: 0 }),
		delay: (endpoint, ms) => void (delays[endpoint] = ms),
		stop: () => void server.stop(true),
	};
}
