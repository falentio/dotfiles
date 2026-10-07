import { isAbsolute, resolve } from "node:path";
import type { SessionDir } from "./session-dir.ts";
import {
  NotFoundError,
  UserError,
  openStore,
  type Counts,
  type Frontier,
  type InboxPointer,
  type OpenGate,
  type StatusReport,
  type Store,
  type Unit,
  type Verdict,
} from "./orch-store.ts";

const DISPLAY_LIMIT = 4;

function countLine(value: Counts): string {
  const entries = Object.entries(value);
  return entries.length === 0
    ? "none"
    : entries.map(([name, count]) => `${name}=${count}`).join(", ");
}

function unitLine(unit: Unit): string {
  return [
    unit.id,
    unit.track,
    unit.state,
    unit.branch,
    unit.pr,
    unit.sha,
    unit.brief,
  ].join("\t");
}

function pointerLine(pointer: InboxPointer): string {
  return [
    pointer.ts,
    pointer.agent,
    pointer.unit,
    pointer.status,
    pointer.report,
  ].join("\t");
}

function gateLine(gate: OpenGate): string {
  return [
    gate.id,
    gate.question,
    gate.options,
    gate.defaultAnswer,
  ].join("\t");
}

function compactRows<T>(
  rows: readonly T[],
  format: (row: T) => string,
  empty: string,
  limit: number | null = DISPLAY_LIMIT,
): string {
  if (rows.length === 0) {
    return empty;
  }
  const visible = limit === null ? rows : rows.slice(0, limit);
  const lines = visible.map(format);
  if (limit !== null && rows.length > limit) {
    lines.push(`... ${rows.length - limit} more; narrow with state/track filters or limit`);
  }
  return lines.join("\n");
}

function frontierLine(value: Frontier): string {
  const prs =
    value.prs.length === 0
      ? "none"
      : value.prs
          .map(
            (row) =>
              `${row.branches}#${row.pr}@${row.sha}:${row.state}`,
          )
          .join(",");
  return `generation=${value.generation} prs=${prs} lowest-unmerged=${value.lowestUnmerged ?? "none"}`;
}

function statusLines(report: StatusReport): string {
  const visible = report.summary.openGateIds.slice(0, DISPLAY_LIMIT);
  const more =
    report.summary.openGateIds.length > DISPLAY_LIMIT
      ? `,+${report.summary.openGateIds.length - DISPLAY_LIMIT} more`
      : "";
  return [
    `counts: units=${report.units.length}; states=${countLine(report.summary.unitStates)}; ledger=${countLine(report.summary.ledgerVerdicts)}`,
    `changed: ${report.changed}`,
    `gates open: ${report.summary.openGateIds.length}${
      visible.length > 0 ? `; ids=${visible.join(",")}${more}` : ""
    }`,
  ].join("\n");
}

function resolveStore(raw: string, directory: string): string {
  return isAbsolute(raw) ? raw : resolve(directory, raw);
}

async function withStore<T>(
  directory: string,
  storePath: string,
  operation: (store: Store) => Promise<T>,
  compact: (result: T) => string,
): Promise<string> {
  const notices: string[] = [];
  const store = openStore(resolveStore(storePath, directory), {
    force: process.env["POTETO_ORCH_FORCE"] === "1",
    onLockStolen: (holder) => void notices.push(`notice: stealing store lock held by pid ${holder}`),
    onStaleLock: (holder) => void notices.push(`notice: replacing stale store lock (pid ${holder} is dead)`),
  });
  try {
    const rendered = compact(await operation(store));
    return [...notices, rendered].filter((part) => part.length > 0).join("\n");
  } catch (error) {
    if (error instanceof NotFoundError && error.output !== undefined) {
      return [...notices, error.output.compact].filter((part) => part.length > 0).join("\n");
    }
    throw error;
  } finally {
    await store.close();
  }
}

function parsePrPin(value: string): readonly number[] {
  return value.split(",").map((part) => {
    const parsed = Number(part);
    if (!/^[1-9]\d*$/.test(part) || !Number.isSafeInteger(parsed)) {
      throw new UserError(`invalid PR pin entry ${JSON.stringify(part)}`);
    }
    return parsed;
  });
}

const storeProp = { type: "string", description: "Store directory, absolute or relative to the session directory." };
const strProp = (description: string) => ({ type: "string", description });
const optStrProp = (description: string) => ({ type: "string", description });
const prNumProp = { type: "integer", minimum: 1 };

function objInput(properties: Record<string, unknown>, required: string[]) {
  return { type: "object", properties, required, additionalProperties: false };
}

type ToolCtx = { sessionID: string };

async function dirOf(deps: { sessionDir: SessionDir }, context: ToolCtx): Promise<string> {
  return deps.sessionDir(context.sessionID);
}

export function buildOrchInitTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_init",
    description: "Initialize a poteto orchestrate store directory.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.init(), (result) => `initialized ${result.store}`) };
    },
  };
}

export function buildOrchUnitAddTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_unit_add",
    description: "Add a work unit to the orchestrate store.",
    input: objInput({ store: storeProp, id: strProp("Unit id."), track: strProp("Unit track."), brief: optStrProp("Short brief.") }, ["store", "id", "track"]),
    async execute(input: { store: string; id: string; track: string; brief?: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.units.add({ id: input.id, track: input.track, brief: input.brief }),
          unitLine,
        ),
      };
    },
  };
}

export function buildOrchUnitSetTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_unit_set",
    description: "Update a work unit state, branch, PR, or SHA.",
    input: objInput(
      {
        store: storeProp,
        id: strProp("Unit id."),
        state: strProp("New state."),
        branch: optStrProp("Branch name."),
        pr: { ...prNumProp, description: "Pull request number." },
        sha: optStrProp("Commit SHA."),
      },
      ["store", "id", "state"],
    ),
    async execute(
      input: { store: string; id: string; state: string; branch?: string; pr?: number; sha?: string },
      context: ToolCtx,
    ) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) =>
            store.units.set({ id: input.id, state: input.state, branch: input.branch, pr: input.pr, sha: input.sha }),
          unitLine,
        ),
      };
    },
  };
}

export function buildOrchUnitGetTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_unit_get",
    description: "Get one work unit by id.",
    input: objInput({ store: storeProp, id: strProp("Unit id.") }, ["store", "id"]),
    async execute(input: { store: string; id: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.units.get(input.id), unitLine) };
    },
  };
}

export function buildOrchUnitListTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_unit_list",
    description: "List work units, optionally filtered by state or track.",
    input: objInput(
      {
        store: storeProp,
        state: optStrProp("Filter by state."),
        track: optStrProp("Filter by track."),
        limit: { type: "integer", minimum: 1, description: "Max rows before truncating with a more-hint." },
      },
      ["store"],
    ),
    async execute(input: { store: string; state?: string; track?: string; limit?: number }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.units.list({ state: input.state, track: input.track }),
          (rows) => compactRows(rows, unitLine, "(no units)", input.limit ?? DISPLAY_LIMIT),
        ),
      };
    },
  };
}

export function buildOrchUnitCountsTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_unit_counts",
    description: "Count work units by state.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.units.counts(), countLine) };
    },
  };
}

export function buildOrchLedgerRecordTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_ledger_record",
    description: "Record a verification verdict for a PR at a SHA.",
    input: objInput(
      {
        store: storeProp,
        pr: { ...prNumProp, description: "Pull request number." },
        sha: strProp("Commit SHA."),
        verdict: strProp("One of live-ui-verified, unit-test-verified, type-check-only, verifier-blocked, verifier-failed."),
        evidence: strProp("Evidence path or note."),
        verifier: optStrProp("Verifier name."),
      },
      ["store", "pr", "sha", "verdict", "evidence"],
    ),
    async execute(
      input: { store: string; pr: number; sha: string; verdict: string; evidence: string; verifier?: string },
      context: ToolCtx,
    ) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) =>
            store.ledger.record({
              pr: input.pr,
              sha: input.sha,
              verdict: input.verdict as Verdict,
              evidence: input.evidence,
              verifier: input.verifier,
            }),
          (row) => `${row.pr}\t${row.sha}\t${row.verdict}`,
        ),
      };
    },
  };
}

export function buildOrchLedgerCheckTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_ledger_check",
    description: "Check the verification verdict for a PR at a SHA. Returns NOT-VERIFIED when absent.",
    input: objInput(
      { store: storeProp, pr: { ...prNumProp, description: "Pull request number." }, sha: strProp("Commit SHA.") },
      ["store", "pr", "sha"],
    ),
    async execute(input: { store: string; pr: number; sha: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.ledger.check({ pr: input.pr, sha: input.sha }),
          (row) => row.verdict,
        ),
      };
    },
  };
}

export function buildOrchLedgerSummaryTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_ledger_summary",
    description: "Count verification verdicts.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.ledger.summary(), countLine) };
    },
  };
}

export function buildOrchInboxPushTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_inbox_push",
    description: "Push an agent status pointer into the inbox.",
    input: objInput(
      {
        store: storeProp,
        agent: strProp("Agent name."),
        unit: strProp("Unit id."),
        status: strProp("Status text."),
        report: optStrProp("Report path or note."),
      },
      ["store", "agent", "unit", "status"],
    ),
    async execute(
      input: { store: string; agent: string; unit: string; status: string; report?: string },
      context: ToolCtx,
    ) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) =>
            store.inbox.push({ agent: input.agent, unit: input.unit, status: input.status, report: input.report }),
          (result) => `${result.pointer.unit}\t${result.pointer.status}\t${result.filename}`,
        ),
      };
    },
  };
}

export function buildOrchInboxDrainTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_inbox_drain",
    description: "Drain inbox pointers, or peek without draining when peek is true.",
    input: objInput(
      { store: storeProp, peek: { type: "boolean", description: "Read without draining." } },
      ["store"],
    ),
    async execute(input: { store: string; peek?: boolean }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => (input.peek === true ? store.inbox.peek() : store.inbox.drain()),
          (rows) => compactRows(rows, pointerLine, "(empty)", null),
        ),
      };
    },
  };
}

export function buildOrchInboxCountTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_inbox_count",
    description: "Count inbox pointers.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.inbox.count(), String) };
    },
  };
}

export function buildOrchGateParkTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_gate_park",
    description: "Park an open decision gate.",
    input: objInput(
      {
        store: storeProp,
        id: strProp("Gate id."),
        question: strProp("Gate question."),
        options: strProp("Gate options."),
        defaultAnswer: strProp("Default answer."),
      },
      ["store", "id", "question", "options", "defaultAnswer"],
    ),
    async execute(
      input: { store: string; id: string; question: string; options: string; defaultAnswer: string },
      context: ToolCtx,
    ) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) =>
            store.gates.park({
              id: input.id,
              question: input.question,
              options: input.options,
              defaultAnswer: input.defaultAnswer,
            }),
          (result) => `${result.id}\topen`,
        ),
      };
    },
  };
}

export function buildOrchGateResolveTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_gate_resolve",
    description: "Resolve an open decision gate with the chosen answer.",
    input: objInput(
      { store: storeProp, id: strProp("Gate id."), answer: strProp("Chosen answer.") },
      ["store", "id", "answer"],
    ),
    async execute(input: { store: string; id: string; answer: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.gates.resolve({ id: input.id, answer: input.answer }),
          (result) => `${result.id}\tresolved\t${result.answer}`,
        ),
      };
    },
  };
}

export function buildOrchGateListTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_gate_list",
    description: "List open decision gates.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.gates.list(),
          (rows) => compactRows(rows, gateLine, "(no open gates)"),
        ),
      };
    },
  };
}

export function buildOrchFrontierSetTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_frontier_set",
    description: "Discover stacked PRs via gh in repo and set the frontier. Optional prs pin is a comma-separated PR list.",
    input: objInput(
      { store: storeProp, repo: strProp("Repository directory."), prs: optStrProp("Comma-separated expected PR order pin.") },
      ["store", "repo"],
    ),
    async execute(input: { store: string; repo: string; prs?: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) =>
            store.frontier.set({
              repo: resolveStore(input.repo, directory),
              prs: input.prs === undefined ? undefined : parsePrPin(input.prs),
            }),
          frontierLine,
        ),
      };
    },
  };
}

export function buildOrchFrontierShowTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_frontier_show",
    description: "Show the current stack frontier.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.frontier.show(), frontierLine) };
    },
  };
}

export function buildOrchStatusTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_status",
    description: "Render status.md and print the summary counts, change text, and open gates.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return { content: await withStore(directory, input.store, (store) => store.status.render(), statusLines) };
    },
  };
}

export function buildOrchStandingAddTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_standing_add",
    description: "Append a standing order line.",
    input: objInput({ store: storeProp, line: strProp("Standing order text.") }, ["store", "line"]),
    async execute(input: { store: string; line: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.standing.add({ line: input.line }),
          (item) => `${item.number}. ${item.line}`,
        ),
      };
    },
  };
}

export function buildOrchStandingShowTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_orch_standing_show",
    description: "Show standing orders.",
    input: objInput({ store: storeProp }, ["store"]),
    async execute(input: { store: string }, context: ToolCtx) {
      const directory = await dirOf(deps, context);
      return {
        content: await withStore(
          directory,
          input.store,
          (store) => store.standing.show(),
          (rows) => compactRows(rows, (item) => `${item.number}. ${item.line}`, "(no standing orders)"),
        ),
      };
    },
  };
}

export function buildOrchTools(deps: { sessionDir: SessionDir }) {
  return [
    buildOrchInitTool(deps),
    buildOrchUnitAddTool(deps),
    buildOrchUnitSetTool(deps),
    buildOrchUnitGetTool(deps),
    buildOrchUnitListTool(deps),
    buildOrchUnitCountsTool(deps),
    buildOrchLedgerRecordTool(deps),
    buildOrchLedgerCheckTool(deps),
    buildOrchLedgerSummaryTool(deps),
    buildOrchInboxPushTool(deps),
    buildOrchInboxDrainTool(deps),
    buildOrchInboxCountTool(deps),
    buildOrchGateParkTool(deps),
    buildOrchGateListTool(deps),
    buildOrchGateResolveTool(deps),
    buildOrchFrontierSetTool(deps),
    buildOrchFrontierShowTool(deps),
    buildOrchStatusTool(deps),
    buildOrchStandingAddTool(deps),
    buildOrchStandingShowTool(deps),
  ];
}
