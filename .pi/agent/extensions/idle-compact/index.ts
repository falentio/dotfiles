import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IDLE_COMPACT_CONFIG, limits, validateConfig, type IdleCompactConfig } from "./config.ts";
import { decide, settledAtFrom, type Limits, type Phase, type Prompt } from "./state.ts";

type UserContent = Parameters<ExtensionAPI["sendUserMessage"]>[0];

const NOTICE = "Compacting the idle context before sending this prompt.";

export function createIdleCompact(config: IdleCompactConfig = IDLE_COMPACT_CONFIG): (pi: ExtensionAPI) => void {
	validateConfig(config);
	const policy = limits(config);
	return (pi) => install(pi, policy);
}

function install(pi: ExtensionAPI, policy: Limits): void {
	let phase: Phase = { kind: "watching", settledAt: Date.now() };

	pi.on("input", (event, ctx) => {
		const usage = ctx.getContextUsage();
		const decision = decide(
			phase,
			{
				text: event.text,
				images: event.images,
				source: event.source,
				streaming: event.streamingBehavior !== undefined || !ctx.isIdle(),
				pendingMessages: ctx.hasPendingMessages(),
				tokens: usage?.tokens ?? null,
			},
			policy,
			Date.now(),
		);
		if (decision.kind === "pass") return;

		phase = { kind: "compacting", prompt: decision.prompt };
		if (ctx.hasUI) ctx.ui.notify(NOTICE, "info");
		ctx.compact({ onComplete: flush, onError: flush });
		return { action: "handled" };
	});

	pi.on("agent_settled", () => {
		phase = { kind: "watching", settledAt: Date.now() };
	});

	pi.on("session_start", (_event, ctx) => {
		phase = { kind: "watching", settledAt: settledAtFrom(ctx.sessionManager.getBranch(), Date.now()) };
	});

	pi.on("session_shutdown", () => {
		phase = { kind: "watching", settledAt: Date.now() };
	});

	function flush(): void {
		if (phase.kind !== "compacting") return;
		const prompt = phase.prompt;
		phase = { kind: "watching", settledAt: Date.now() };
		pi.sendUserMessage(contentOf(prompt), { expandPromptTemplates: true });
	}
}

function contentOf(prompt: Prompt): UserContent {
	if (prompt.images === undefined || prompt.images.length === 0) return prompt.text;
	return [{ type: "text" as const, text: prompt.text }, ...prompt.images];
}

export default function idleCompact(pi: ExtensionAPI): void {
	createIdleCompact()(pi);
}
