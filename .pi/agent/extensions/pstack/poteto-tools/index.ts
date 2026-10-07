import type { SessionDir, V2Tool } from "./session-dir.ts";
import { buildCheckPlanTool } from "./check-plan.ts";
import { buildOrchTools } from "./orch-tools.ts";
import { buildWatchPrTools } from "./watch-pr-tools.ts";
import { buildWorktreeAuditTool } from "./worktree-audit.ts";

export type { SessionDir, V2Tool } from "./session-dir.ts";

export function buildPotetoTools(deps: { sessionDir: SessionDir }): V2Tool[] {
  return [
    buildCheckPlanTool(deps),
    ...buildOrchTools(deps),
    ...buildWatchPrTools(),
    buildWorktreeAuditTool(deps),
  ];
}
