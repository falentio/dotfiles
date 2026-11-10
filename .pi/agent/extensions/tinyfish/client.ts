import { readStore, type AccountStore } from "./accounts.ts";
import { POOL_CONFIG, type CallConfig, type PoolConfig } from "./config.ts";
import { exhausted, toolError, type Depletion, type Exhaustion } from "./errors.ts";
import { send, type Attempt, type EndpointRequest, type Transport } from "./http.ts";
import type { FetchParams, SearchParams } from "./params.ts";
import type { Pool } from "./pool.ts";

export interface CallDeps {
	readonly pool: Pool;
	readonly config: CallConfig;
	readonly poolConfig?: PoolConfig;
	readonly transport?: Transport;
	/** Re-read for one last look when the pool comes up empty; defaults to the real store. */
	readonly reload?: () => Promise<AccountStore>;
	/** Millis inside `backoffMs`, injected so a test does not spend them. */
	readonly sleep?: (ms: number) => Promise<void>;
}

export interface Client {
	search(params: SearchParams, signal?: AbortSignal): Promise<unknown>;
	fetchContent(params: FetchParams, signal?: AbortSignal): Promise<unknown>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The exhaustion behind an acquire rejection, so the loop can tell "woke up empty" from "waited past". */
const exhaustionOf = (error: unknown): Exhaustion | null => {
	const cause = (error as { cause?: unknown }).cause;
	if (typeof cause !== "object" || cause === null) return null;
	if (!("type" in cause) || cause.type !== "tinyfish-exhausted") return null;
	return "reason" in cause ? (cause.reason as Exhaustion) : null;
};

/**
 * The whole retry policy. Rotates on rate-limited, dead-key, spent, and transient; surfaces on invalid;
 * gives up after `maxTransient` transport turns. Every turn re-acquires, and both exits release.
 *
 * `maxWaitMs` is one deadline for the whole call, not per turn, so a pool that keeps cooling cannot
 * stall the agent past it: the turn that would land later throws naming the endpoint and its limit.
 */
export const callPool = async (
	deps: CallDeps,
	request: EndpointRequest,
	signal?: AbortSignal,
): Promise<unknown> => {
	const wire = deps.transport ?? send;
	const sleep = deps.sleep ?? defaultSleep;
	const reload = deps.reload ?? readStore;
	const deadline = deps.pool.now() + (deps.poolConfig ?? POOL_CONFIG).maxWaitMs;
	let turns = 0;
	let reloaded = false;
	for (;;) {
		let lease;
		try {
			lease = await deps.pool.acquire(request.endpoint, signal, deadline);
		} catch (error) {
			const reason = exhaustionOf(error);
			if (reason === null) throw error;
			if (reason.kind === "all-cooling" && reason.releaseAt > deadline) throw capError(reason);
			// A key added out of process joins here, at the moment the pool runs dry, with no restart.
			// Once per call is enough: a second look that finds nothing is the same store as the first.
			if (reloaded) throw error;
			reloaded = true;
			deps.pool.reload(await reload());
			continue;
		}
		let attempt: Attempt;
		try {
			attempt = await wire(request, lease, signal ?? new AbortController().signal);
		} catch (error) {
			// A socket blip is a transient turn, spending the same budget a 5xx does. Only an abort escapes.
			if (signal?.aborted === true) {
				lease.release({ kind: "transient" });
				throw error;
			}
			attempt = { outcome: { kind: "transient" } };
		}
		lease.release(attempt.outcome);
		if (attempt.outcome.kind === "ok") return attempt.body;
		switch (attempt.outcome.kind) {
			case "invalid":
				throw toolError(attempt.outcome.error);
			case "transient":
				turns += 1;
				if (turns > deps.config.maxTransient) throw toolError(exhausted({ kind: "transient", turns }));
				await sleep(deps.config.backoffMs(turns));
				continue;
			case "rate-limited":
			case "dead-key":
			case "spent":
				continue;
		}
	}
};

/** Past the cap the pool answered "wait", so the reason carries the endpoint and the limit it named. */
const capError = (reason: Extract<Depletion, { kind: "all-cooling" }>): Error =>
	toolError(exhausted(reason));

export const createClient = (deps: CallDeps): Client => ({
	search: (params, signal) => callPool(deps, { endpoint: "search", params }, signal),
	fetchContent: (params, signal) => callPool(deps, { endpoint: "fetch", params }, signal),
});
