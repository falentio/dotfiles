export type Endpoint = "search" | "fetch";

type Scripted = { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> };

export interface Stub {
	readonly searchBase: string;
	readonly fetchBase: string;
	readonly seen: string[];
	/** Clears the delivery counters, so a test asserts its own calls and not the previous test's. */
	reset(): void;
	hit(key: string, endpoint: Endpoint): number;
	script(key: string, endpoint: Endpoint, answers: readonly Scripted[]): void;
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
		reset: () => {
			seen.length = 0;
			delivered.clear();
		},
		hit: (key, endpoint) => delivered.get(`${key} ${endpoint}`) ?? 0,
		script: (key, endpoint, answers) => void scripts.set(`${key} ${endpoint}`, { answers, taken: 0 }),
		stop: () => void server.stop(true),
	};
}
