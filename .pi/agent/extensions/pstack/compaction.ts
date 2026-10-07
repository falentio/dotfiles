import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Evidence = { kind: "slash-command" | "skill-read" | "delegate"; detail: string };

const MAX_ENTRIES = 300;
const SLASH_PATTERN = /(^|\s)\/skill:poteto-mode(?![\w-])/;
const OPT_OUT_PATTERN = /\b(opt\s*-?\s*out|disable|turn\s+off|quit)\b/i;
const SKILL_MARKER = "# Poteto mode";
const SESSION_PICKUP_PATH = "skills/poteto-mode/playbooks/session-pickup.md";

function textOf(entry: unknown): string {
  try {
    return JSON.stringify(entry) ?? "";
  } catch {
    return "";
  }
}

export function findEvidence(entries: readonly unknown[]): Evidence | null {
  const limit = Math.min(entries.length, MAX_ENTRIES);
  for (let i = 0; i < limit; i++) {
    const text = textOf(entries[i]);
    if (!text) continue;
    const mentionsSkill = text.includes(SKILL_MARKER);
    if (mentionsSkill || SLASH_PATTERN.test(text)) {
      const instruction = mentionsSkill ? text.slice(text.indexOf(SKILL_MARKER) + SKILL_MARKER.length) : text;
      if (!OPT_OUT_PATTERN.test(instruction)) {
        return { kind: "slash-command", detail: instruction.trim().slice(0, 200) };
      }
    }
    if (text.includes("delegate_task") && (text.includes("poteto-agent") || text.includes("implementation"))) {
      return { kind: "delegate", detail: "delegate_task spawned an implementation delegate" };
    }
  }
  return null;
}

function resumeNote(evidence: Evidence): string {
  return [
    `Poteto mode was active earlier in this session (evidence: ${evidence.kind}).`,
    `Compaction dropped the skill text. Read the poteto-mode skill's SKILL.md again with the read tool before any further work, and follow the copy it returns rather than stale instructions from before the summary.`,
    `Resume from the compaction summary using ${SESSION_PICKUP_PATH}.`,
    `If the user opted out, ignore this note.`,
  ].join(" ");
}

export function registerCompactionResume(pi: ExtensionAPI): void {
  const pending = new Map<string, Evidence>();

  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getBranch().map((entry) => entry as unknown);
    const evidence = findEvidence(entries);
    if (evidence) pending.set(ctx.sessionManager.getSessionId(), evidence);
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    pending.delete(ctx.sessionManager.getSessionId());
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    const evidence = pending.get(id);
    if (!evidence) return;
    pending.delete(id);
    const options = event.systemPromptOptions as { appendSystemPrompt?: string };
    const existing = options.appendSystemPrompt ?? "";
    options.appendSystemPrompt = existing ? `${existing}\n\n${resumeNote(evidence)}` : resumeNote(evidence);
  });
}
