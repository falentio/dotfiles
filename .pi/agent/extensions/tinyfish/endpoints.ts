import type { Account } from "./accounts.ts";
import { fetchBaseUrl, searchBaseUrl } from "./config.ts";

export type EndpointId = "search" | "fetch";

export interface Endpoint {
	readonly id: EndpointId;
	readonly baseUrl: () => string;
	readonly windowMs: number;
	readonly perWindow: number;
}

export const ENDPOINTS: Readonly<Record<EndpointId, Endpoint>> = {
	search: { id: "search", baseUrl: searchBaseUrl, windowMs: 60_000, perWindow: 30 },
	fetch: { id: "fetch", baseUrl: fetchBaseUrl, windowMs: 60_000, perWindow: 150 },
};

export const spacingOf = (endpoint: Endpoint, account: Account): number =>
	endpoint.windowMs / (endpoint.perWindow * account.weight);
