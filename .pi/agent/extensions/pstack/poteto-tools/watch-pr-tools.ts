import {
  GhGitHubReader,
  WatcherQueryError,
  discoverStack,
  resolveContext,
} from "./watch-pr-github.ts";
import {
  classifyPr,
  readSnapshot,
  selectTierMajorStackDecision,
} from "./watch-pr-policy.ts";
import { renderJson, renderPretty } from "./watch-pr-render.ts";
import type * as T from "./watch-pr-types.ts";
import { nonEmpty, parsePrNumber } from "./watch-pr-types.ts";

export const __test__ = {
  createReader(): T.GitHubReader {
    return new GhGitHubReader();
  },
};

function observedAt(): string {
  return new Date().toISOString();
}

function toBlockerVerdict(
  blocker: T.MergeBlocker,
  mode: "single" | "stack"
): T.BlockerVerdict {
  const base = {
    schemaVersion: 1 as const,
    sequence: 1,
    observedAt: observedAt(),
    mode,
    kind: "BLOCKER" as const,
    terminal: true as const,
  };
  switch (blocker.kind) {
    case "merge-conflicts":
      return { ...base, exitCode: 2 as const, blocker };
    case "review-threads":
      return { ...base, exitCode: 3 as const, blocker };
    case "failing-checks":
      return { ...base, exitCode: 4 as const, blocker };
    case "merge-gate":
      return { ...base, exitCode: 6 as const, blocker };
    default: {
      const exhaustive: never = blocker;
      return exhaustive;
    }
  }
}

function toStatusQueryVerdict(
  failure: T.QueryFailure,
  mode: "single" | "stack"
): T.BlockerVerdict {
  return {
    schemaVersion: 1,
    sequence: 1,
    observedAt: observedAt(),
    mode,
    kind: "BLOCKER",
    terminal: true,
    exitCode: 7,
    blocker: { kind: "status-query", failures: 1, failure },
  };
}

function toReadySingleVerdict(
  pr: T.ReadyPr | T.MergedPr,
  mode: "single" | "stack"
): T.TerminalVerdict {
  return {
    schemaVersion: 1,
    sequence: 1,
    observedAt: observedAt(),
    mode,
    kind: "READY",
    terminal: true,
    exitCode: 0,
    scope: { kind: "single", pr },
  };
}

function toReadyStackVerdict(
  prs: T.NonEmpty<T.ReadyPr | T.MergedPr>
): T.TerminalVerdict {
  return {
    schemaVersion: 1,
    sequence: 1,
    observedAt: observedAt(),
    mode: "stack",
    kind: "READY",
    terminal: true,
    exitCode: 0,
    scope: { kind: "stack", prs },
  };
}

function toWaitingVerdict(
  frontier: T.PrContext,
  pending: T.NonEmpty<T.PendingCheck>,
  mode: "single" | "stack"
): T.WatcherVerdict {
  return {
    schemaVersion: 1,
    sequence: 1,
    observedAt: observedAt(),
    mode,
    kind: "WAITING",
    terminal: false,
    frontier,
    reason: { kind: "pending-checks", pending },
  };
}

function render(
  verdict: T.WatcherVerdict,
  pretty: boolean | undefined
): string {
  return pretty === true ? renderPretty(verdict) : renderJson(verdict);
}

function optionalPrNumber(value: number | undefined): T.PrNumber | null {
  return value === undefined ? null : parsePrNumber(value);
}

type SnapshotArgs = {
  owner?: string;
  repo?: string;
  pr?: number;
  allowDraft?: boolean;
};

async function readSingleSnapshot(
  reader: T.GitHubReader,
  args: SnapshotArgs
): Promise<T.PrSnapshot> {
  const context = await resolveContext({
    reader,
    owner: args.owner ?? null,
    repo: args.repo ?? null,
    pr: optionalPrNumber(args.pr),
  });
  return readSnapshot({
    reader,
    context,
    pendingHistory: "include",
    allowDraft: args.allowDraft ?? false,
  });
}

type PrStatusInput = { owner?: string; repo?: string; pr?: number; pretty?: boolean; allowDraft?: boolean };
type PrStackInput = PrStatusInput & { statusOnly?: boolean };

const prOwnerProp = { type: "string", description: "GitHub repository owner." };
const prRepoProp = { type: "string", description: "GitHub repository name." };
const prNumberProp = { type: "integer", minimum: 1, description: "Pull request number." };
const prettyProp = { type: "boolean", description: "Render human text instead of JSON." };
const allowDraftProp = { type: "boolean", description: "Do not treat a draft as a merge gate." };

export function buildWatchPrStatusTool() {
  return {
    name: "poteto_watch_pr_status",
    description:
      "Read one PR snapshot and classify it ready, waiting, or blocker. Single-shot and read-only; caller re-invokes to poll. Shells only to gh and git.",
    input: {
      type: "object",
      properties: { owner: prOwnerProp, repo: prRepoProp, pr: prNumberProp, pretty: prettyProp, allowDraft: allowDraftProp },
      required: [],
      additionalProperties: false,
    },
    async execute(args: PrStatusInput) {
      const reader = __test__.createReader();
      try {
        const snapshot = await readSingleSnapshot(reader, args);
        const decision = classifyPr(snapshot, args.allowDraft ?? false);
        let verdict: T.WatcherVerdict;
        if (decision.kind === "blocker") verdict = toBlockerVerdict(decision.blocker, "single");
        else if (decision.kind === "waiting")
          verdict = toWaitingVerdict(decision.frontier, decision.pending, "single");
        else verdict = toReadySingleVerdict(decision.pr, "single");
        return { content: render(verdict, args.pretty) };
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;
        return { content: render(toStatusQueryVerdict(error.failure, "single"), args.pretty) };
      }
    },
  };
}

export function buildWatchPrStackTool() {
  return {
    name: "poteto_watch_pr_stack",
    description:
      "Read the connected open stack and apply the tier-major decision. Single-shot and read-only; caller re-invokes to poll. Shells only to gh and git.",
    input: {
      type: "object",
      properties: {
        owner: prOwnerProp,
        repo: prRepoProp,
        pr: prNumberProp,
        pretty: prettyProp,
        statusOnly: { type: "boolean", description: "Return one STATUS table over the stack instead of a decision." },
        allowDraft: allowDraftProp,
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args: PrStackInput) {
      const reader = __test__.createReader();
      try {
        const seed = await resolveContext({
          reader,
          owner: args.owner ?? null,
          repo: args.repo ?? null,
          pr: optionalPrNumber(args.pr),
        });
        const contexts = await discoverStack(reader, seed);
        const rows: T.PrSnapshot[] = [];
        for (const context of contexts)
          rows.push(
            await readSnapshot({
              reader,
              context,
              pendingHistory: "include",
              allowDraft: args.allowDraft ?? false,
            })
          );
        const complete = nonEmpty(rows);
        if (complete === null) throw new Error("watch context cannot be empty");
        if (args.statusOnly === true) {
          return {
            content: render(
              {
                schemaVersion: 1,
                sequence: 1,
                observedAt: observedAt(),
                mode: "stack",
                kind: "STATUS",
                terminal: true,
                exitCode: 0,
                reason: "status-only",
                rows: complete,
              },
              args.pretty,
            ),
          };
        }
        const decision = selectTierMajorStackDecision(complete, args.allowDraft ?? false);
        let verdict: T.WatcherVerdict;
        if (decision.kind === "blocker") verdict = toBlockerVerdict(decision.blocker, "stack");
        else if (decision.kind === "waiting")
          verdict = toWaitingVerdict(decision.frontier, decision.pending, "stack");
        else verdict = toReadyStackVerdict(decision.prs);
        return { content: render(verdict, args.pretty) };
      } catch (error) {
        if (!(error instanceof WatcherQueryError)) throw error;
        return { content: render(toStatusQueryVerdict(error.failure, "stack"), args.pretty) };
      }
    },
  };
}

export function buildWatchPrClassifyTool() {
  return {
    name: "poteto_watch_pr_classify",
    description:
      "Return the raw snapshot plus decision kind for one PR as JSON. Read-only; shells only to gh and git.",
    input: {
      type: "object",
      properties: { owner: prOwnerProp, repo: prRepoProp, pr: prNumberProp, allowDraft: allowDraftProp },
      required: [],
      additionalProperties: false,
    },
    async execute(args: PrStatusInput) {
      const reader = __test__.createReader();
      const context = await resolveContext({
        reader,
        owner: args.owner ?? null,
        repo: args.repo ?? null,
        pr: optionalPrNumber(args.pr),
      });
      const snapshot = await readSnapshot({
        reader,
        context,
        pendingHistory: "include",
        allowDraft: args.allowDraft ?? false,
      });
      const decision = classifyPr(snapshot, args.allowDraft ?? false);
      return { content: `${JSON.stringify({ snapshot, decision })}\n` };
    },
  };
}

export function buildWatchPrTools() {
  return [buildWatchPrStatusTool(), buildWatchPrStackTool(), buildWatchPrClassifyTool()];
}
