import {
	estimateTokens,
	findCutPoint,
	sessionEntryToContextMessages,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type AgentMessage = Extract<SessionEntry, { type: "message" }>["message"];

export interface Plan {
	readonly coveredEntryIds: readonly string[];
	readonly keepEntryId: string;
	readonly messages: readonly AgentMessage[];
	readonly previousSummary: string | undefined;
	readonly modelRef: string;
	readonly tailTokens: number;
}

export function planPrecompute(
	entries: readonly SessionEntry[],
	keepRecentTokens: number,
	modelRef: string,
): Plan | undefined {
	let boundaryStart = 0;
	let previousSummary: string | undefined;

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type === "compaction") {
			previousSummary = entry.summary;
			const firstKeptIndex = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			boundaryStart = firstKeptIndex >= 0 ? firstKeptIndex : i + 1;
			break;
		}
	}

	const cut = findCutPoint([...entries], boundaryStart, entries.length, keepRecentTokens);
	const keepEntry = entries[cut.firstKeptEntryIndex];
	if (!keepEntry?.id) return undefined;

	const messages: AgentMessage[] = [];
	const coveredEntryIds: string[] = [];
	for (let i = boundaryStart; i < cut.firstKeptEntryIndex; i++) {
		const entry = entries[i];
		if (!entry || entry.type === "compaction") continue;
		const projected = sessionEntryToContextMessages(entry);
		if (projected.length === 0) continue;
		messages.push(...projected);
		coveredEntryIds.push(entry.id);
	}

	if (messages.length === 0) return undefined;

	return {
		coveredEntryIds,
		keepEntryId: keepEntry.id,
		messages,
		previousSummary,
		modelRef,
		tailTokens: tailTokensFrom(entries, keepEntry.id) ?? 0,
	};
}

export function tailTokensFrom(
	entries: readonly SessionEntry[],
	keepEntryId: string,
): number | undefined {
	const keepIndex = entries.findIndex((entry) => entry.id === keepEntryId);
	if (keepIndex < 0) return undefined;

	let tokens = 0;
	for (let i = keepIndex; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;
		for (const message of sessionEntryToContextMessages(entry)) {
			tokens += estimateTokens(message);
		}
	}
	return tokens;
}
