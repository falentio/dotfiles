import type { InputEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

export type ImageContent = NonNullable<InputEvent["images"]>[number];
export type InputSource = InputEvent["source"];

export interface Prompt {
	readonly text: string;
	readonly images?: readonly ImageContent[];
}

export type Phase =
	| { readonly kind: "watching"; readonly settledAt: number }
	| { readonly kind: "compacting"; readonly prompt: Prompt };

export interface Limits {
	readonly enabled: boolean;
	readonly idleMs: number;
	readonly minTokens: number;
}

export interface Input {
	readonly text: string;
	readonly images?: readonly ImageContent[];
	readonly source: InputSource;
	readonly streaming: boolean;
	readonly pendingMessages: boolean;
	readonly tokens: number | null;
}

export type Decision =
	| { readonly kind: "pass" }
	| { readonly kind: "take"; readonly prompt: Prompt };

const PASS: Decision = { kind: "pass" };

export function decide(state: Phase, input: Input, limits: Limits, now: number): Decision {
	if (!limits.enabled) return PASS;
	if (state.kind === "compacting") return PASS;
	if (input.source === "extension") return PASS;
	if (input.streaming || input.pendingMessages) return PASS;
	if (now - state.settledAt < limits.idleMs) return PASS;
	if (input.tokens === null || input.tokens < limits.minTokens) return PASS;
	if (input.text.trim() === "") return PASS;
	return { kind: "take", prompt: { text: input.text, images: input.images } };
}

export function settledAtFrom(branch: readonly SessionEntry[], now: number): number {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const at = Date.parse(entry.timestamp);
		return Number.isNaN(at) ? now : at;
	}
	return now;
}
