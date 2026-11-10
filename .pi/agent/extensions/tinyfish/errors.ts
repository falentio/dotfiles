import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS, type EndpointId } from "./endpoints.ts";
import type { Limit } from "./pool.ts";

/** Why nothing can serve this endpoint. Every arm is actionable by the operator. */
export type Depletion =
	| {
			readonly kind: "all-cooling";
			readonly endpoint: EndpointId;
			readonly releaseAt: number;
			readonly limit: Limit | null;
			/** Keys out of credits alongside the paced ones, so "retry" and "top up" read apart. */
			readonly spentCount: number;
			/** The soonest of those returns, or null when none is spent. */
			readonly spentAt: number | null;
	  }
	| { readonly kind: "all-spent"; readonly walletUrl: string | null }
	| { readonly kind: "all-dead" }
	| { readonly kind: "no-accounts" };

/** A depletion, plus the one reason that belongs to the call loop rather than to a selection. */
export type Exhaustion = Depletion | { readonly kind: "transient"; readonly turns: number };

export type TinyfishToolError =
	| { readonly type: "tinyfish-exhausted"; readonly reason: Exhaustion }
	| { readonly type: "tinyfish-invalid"; readonly status: number; readonly body: unknown }
	| { readonly type: "tinyfish-transport"; readonly message: string };

export const exhausted = (reason: Exhaustion): TinyfishToolError => ({ type: "tinyfish-exhausted", reason });

export const invalid = (status: number, body: unknown): TinyfishToolError => ({
	type: "tinyfish-invalid",
	status,
	body,
});

export const transport = (message: string): TinyfishToolError => ({ type: "tinyfish-transport", message });

/** Not `import.meta.dir`: pi also loads extensions under Node, where only the URL exists. */
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/** The command that puts a key in the store. The operator's whole fix for an empty or dead pool. */
export const addKeyCommand = (): string => `printf '%s' '<key>' | ${join(EXTENSION_DIR, "bin", "tinyfish-auth-set")}`;

/** A span an operator acts on: whole minutes past a minute, whole seconds below it. */
const span = (ms: number): string =>
	ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * `search: 30/minute`, from the server's own numbers, or the endpoint's ceiling marked as a local guess.
 * A window past two minutes is spelled out, because `30/minute` alone reads as a minute-long cooldown.
 */
const limitText = (endpoint: EndpointId, limit: Limit | null): string => {
	if (limit === null) return `${endpoint}: ${ENDPOINTS[endpoint].perWindow}/minute (the local default; the server named no limit)`;
	const named = `${endpoint}: ${limit.limit}/${limit.unit}`;
	return limit.windowSeconds >= 120 ? `${named} over a ${span(limit.windowSeconds * 1000)} window` : named;
};

const clock = (at: Date): string =>
	at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The only place the operator's failure text exists. */
export const render = (error: TinyfishToolError): string => {
	switch (error.type) {
		case "tinyfish-transport":
			return `TinyFish transport failure: ${error.message}`;
		case "tinyfish-invalid":
			return `TinyFish rejected the request (HTTP ${error.status}): ${JSON.stringify(error.body)}`;
		case "tinyfish-exhausted":
			return renderExhaustion(error.reason);
	}
};

const renderExhaustion = (reason: Exhaustion): string => {
	switch (reason.kind) {
		case "no-accounts":
			return addKeyCommand();
		case "all-cooling": {
			const spent =
				reason.spentAt === null
					? ""
					: ` ${reason.spentCount} of them ${reason.spentCount === 1 ? "is" : "are"} out of credits; the soonest returns in ${span(reason.spentAt - reason.releaseAt)}.`;
			return `TinyFish wait limit hit: every key is cooling on ${limitText(reason.endpoint, reason.limit)}, next free at ${clock(new Date(reason.releaseAt))}.${spent} Retry then.`;
		}
		case "all-spent":
			return `Every TinyFish key is out of credits.${reason.walletUrl === null ? "" : ` Top up at ${reason.walletUrl}.`}`;
		case "all-dead":
			return `Every TinyFish key was rejected as invalid. Replace them with:\n${addKeyCommand()}`;
		case "transient":
			return `TinyFish failed ${reason.turns} times in a row with no usable outcome.`;
	}
};

/** The thrown form a caller sees. `cause` keeps the arm readable by the call loop. */
export const toolError = (error: TinyfishToolError): Error => new Error(render(error), { cause: error });

export const isToolError = (value: unknown): value is TinyfishToolError =>
	typeof value === "object" &&
	value !== null &&
	"type" in value &&
	typeof value.type === "string" &&
	value.type.startsWith("tinyfish-");
