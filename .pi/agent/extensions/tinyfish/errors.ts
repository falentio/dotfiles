import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDPOINTS, type EndpointId } from "./endpoints.ts";
import type { Limit } from "./pool.ts";

export type Depletion =
	| {
			readonly kind: "all-cooling";
			readonly endpoint: EndpointId;
			readonly releaseAt: number;
			readonly releaseInMs: number;
			readonly limit: Limit | null;
			readonly spentCount: number;
			readonly spentAt: number | null;
			readonly tried: readonly string[];
	  }
	| { readonly kind: "all-spent"; readonly walletUrl: string | null }
	| { readonly kind: "all-dead" }
	| { readonly kind: "no-accounts" };

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

export const addKeyCommand = (): string => `printf '%s' '<key>' | ${join(EXTENSION_DIR, "bin", "tinyfish-auth-set")}`;

const span = (ms: number): string => {
	const total = Math.max(0, Math.round(ms / 1000));
	if (total < 60) return `${Math.max(1, total)}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
};

/** A window past two minutes is spelled out, because `30/minute` alone reads as a minute-long cooldown. */
const limitText = (endpoint: EndpointId, limit: Limit | null): string => {
	if (limit === null) return `${endpoint}: ${ENDPOINTS[endpoint].perWindow}/minute (the local default; the server named no limit)`;
	const named = `${endpoint}: ${limit.limit}/${limit.unit}`;
	return limit.windowSeconds >= 120 ? `${named} over a ${span(limit.windowSeconds * 1000)} window` : named;
};

/** UTC, so the reading means one thing on every host. The span beside it is what the operator acts on. */
const clock = (at: number): string => `${new Date(at).toISOString().slice(11, 19)}Z`;

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
			const burned = reason.tried.length === 0 ? "" : ` Tried: ${reason.tried.join(", ")}.`;
			return `TinyFish wait limit hit: every key is cooling on ${limitText(reason.endpoint, reason.limit)}, next free in ${span(reason.releaseInMs)} at ${clock(reason.releaseAt)}.${spent}${burned} Retry then.`;
		}
		case "all-spent":
			return `Every TinyFish key is out of credits.${reason.walletUrl === null ? "" : ` Top up at ${reason.walletUrl}.`}`;
		case "all-dead":
			return `Every TinyFish key was rejected as invalid. Replace them with:\n${addKeyCommand()}`;
		case "transient":
			return `TinyFish failed ${reason.turns} times in a row with no usable outcome.`;
	}
};

export const toolError = (error: TinyfishToolError): Error => new Error(render(error), { cause: error });

export const isToolError = (value: unknown): value is TinyfishToolError =>
	typeof value === "object" &&
	value !== null &&
	"type" in value &&
	typeof value.type === "string" &&
	value.type.startsWith("tinyfish-");
