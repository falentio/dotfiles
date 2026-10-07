import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { V2Tool } from "./poteto-tools/session-dir.ts";
import { buildCheckPlanTool } from "./poteto-tools/check-plan.ts";
import { buildOrchTools } from "./poteto-tools/orch-tools.ts";
import { buildWatchPrTools } from "./poteto-tools/watch-pr-tools.ts";
import { buildWorktreeAuditTool } from "./poteto-tools/worktree-audit.ts";
import { registerCompactionResume } from "./compaction.ts";

type Deps = { sessionDir: (sessionID: string) => Promise<string> };
type ToolBuilder = (deps: Deps) => V2Tool | V2Tool[];

const builders: ToolBuilder[] = [
  buildCheckPlanTool,
  buildOrchTools,
  buildWatchPrTools,
  buildWorktreeAuditTool,
];

function registerTool(pi: ExtensionAPI, build: ToolBuilder, shape: V2Tool): void {
  pi.registerTool({
    name: shape.name,
    label: shape.name,
    description: shape.description,
    parameters: shape.input as unknown as never,
    exposure: "codemode",
    async execute(_toolCallId: string, params: never, _signal, _onUpdate, ctx: ExtensionToolContext) {
      const produced = build({ sessionDir: async () => ctx.cwd });
      const tool = Array.isArray(produced) ? produced.find((t) => t.name === shape.name) : produced;
      if (!tool) throw new Error(`tool ${shape.name} not found in builder output`);
      const result = await tool.execute(params, { sessionID: "" });
      return { content: [{ type: "text" as const, text: result.content }], details: undefined };
    },
  });
}

export default function (pi: ExtensionAPI) {
  registerCompactionResume(pi);

  for (const build of builders) {
    const produced = build({ sessionDir: async () => process.cwd() });
    const shapes = Array.isArray(produced) ? produced : [produced];
    for (const shape of shapes) registerTool(pi, build, shape);
  }
}
