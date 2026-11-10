import { join } from "node:path";
import { ENDPOINTS, type EndpointId } from "./endpoints.ts";
import type { Limit } from "./pool.ts";

/** Why nothing can serve this endpoint. Every arm is actionable by the operator. */
export type Depletion =
	| { readonly kind: "all-cooling"; readonly endpoint: EndpointId; readonly releaseAt: number; readonly limit: Limit | null }
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

/** The command that puts a key in the store. The operator's whole fix for an empty or dead pool. */
export const addKeyCommand = (): string =>
	`printf '%s' '<key>' | ${join(import.meta.dir, "bin", "tinyfish-auth-set")}`;

/** `search: 30/min`, from the server's own numbers when it gave them. */
const limitText = (endpoint: EndpointId, limit: Limit | null): string =>
	`${endpoint}: ${limit?.limit ?? ENDPOINTS[endpoint].perWindow}${limit === null ? "/min" : `/${limit.unit}`}`;

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
		case "all-cooling":
			return `TinyFish wait limit hit: every key is cooling on ${limitText(reason.endpoint, reason.limit)}, next free at ${clock(new Date(reason.releaseAt))}. Retry then.`;
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
