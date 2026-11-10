import { readStore, type AccountStore } from "./accounts.ts";
import type { CallConfig, PoolConfig } from "./config.ts";
import { exhausted, toolError, type Depletion, type Exhaustion } from "./errors.ts";
import { send, type Attempt, type EndpointRequest, type Transport } from "./http.ts";
import type { FetchParams, SearchParams } from "./params.ts";
import type { Pool } from "./pool.ts";

export interface CallDeps {
	readonly pool: Pool;
	readonly config: CallConfig;
	readonly poolConfig: PoolConfig;
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

const exhaustionOf = (error: unknown): Exhaustion | null => {
	const cause = (error as { cause?: unknown }).cause;
	if (typeof cause !== "object" || cause === null) return null;
	if (!("type" in cause) || cause.type !== "tinyfish-exhausted") return null;
	return "reason" in cause ? (cause.reason as Exhaustion) : null;
};

/**
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
	const reload = deps.reload ?? (async () => (await readStore()).store);
	const deadline = deps.pool.now() + deps.poolConfig.maxWaitMs;
	let turns = 0;
	let reloaded = false;
	const tried: string[] = [];
	for (;;) {
		let lease;
		try {
			lease = await deps.pool.acquire(request.endpoint, signal, deadline);
		} catch (error) {
			const reason = exhaustionOf(error);
			if (reason === null) throw error;
			if (reason.kind === "all-cooling" && reason.releaseAt > deadline) throw capError(reason, tried);
			// Only a new key can fix these two; a paced or spent pool is the same pool after a re-read.
			if (reason.kind !== "no-accounts" && reason.kind !== "all-dead") throw error;
			// A key added out of process joins here, at the moment the pool runs dry, with no restart.
			// Once per call is enough: a second look that finds nothing is the same store as the first.
			if (reloaded) throw error;
			reloaded = true;
			deps.pool.reload(await reload());
			continue;
		}
		tried.push(lease.account.label);
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

const capError = (reason: Extract<Depletion, { kind: "all-cooling" }>, tried: readonly string[]): Error =>
	toolError(exhausted({ ...reason, tried: [...new Set(tried)] }));

export const createClient = (deps: CallDeps): Client => ({
	search: (params, signal) => callPool(deps, { endpoint: "search", params }, signal),
	fetchContent: (params, signal) => callPool(deps, { endpoint: "fetch", params }, signal),
});
