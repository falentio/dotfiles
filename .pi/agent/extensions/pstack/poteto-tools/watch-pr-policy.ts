import { resolveChecks } from "./watch-pr-github.ts";
import type * as T from "./watch-pr-types.ts";
import { nonEmpty } from "./watch-pr-types.ts";
export function assessGitHubMerge(args: {
  readonly mergeStateStatus: T.MergeStateStatus;
  readonly headRollupState: T.RollupState;
}): T.GitHubMergeAssessment {
  if (args.mergeStateStatus === "BLOCKED") {
    if (args.headRollupState === "ERROR" || args.headRollupState === "FAILURE")
      return {
        kind: "refused",
        mergeStateStatus: args.mergeStateStatus,
        headRollupState: args.headRollupState,
      };
    return {
      kind: "allowed",
      basis: "rollup",
      mergeStateStatus: args.mergeStateStatus,
      headRollupState: args.headRollupState,
    };
  }
  return {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: args.mergeStateStatus,
    headRollupState: args.headRollupState,
  };
}
async function mergeAssessment(
  reader: T.GitHubReader,
  facts: T.PullRequestFacts
) {
  const commits = await reader.commitRollups(facts.context);
  const headRollupState =
    facts.headRefOid === null
      ? null
      : (commits.find((commit) => commit.oid === facts.headRefOid)?.state ??
        null);
  return {
    hadPreviousPassingCi: commits.some(
      (commit) => commit.oid !== facts.headRefOid && commit.state === "SUCCESS"
    ),
    github: assessGitHubMerge({
      mergeStateStatus: facts.mergeStateStatus,
      headRollupState,
    }),
  };
}
const AUTOMATION_TOKENS = [
  "bugbot",
  "security review",
  "pr review automation",
  "review automation",
] as const;
export async function readSnapshot(args: {
  readonly reader: T.GitHubReader;
  readonly context: T.PrContext;
  readonly pendingHistory: "include" | "omit";
  readonly allowDraft: boolean;
}): Promise<T.PrSnapshot> {
  const facts = await args.reader.pullRequest(args.context);
  if (facts.state === "MERGED" || facts.mergedAt !== null)
    return { kind: "merged", context: args.context, facts };
  if (facts.state === "CLOSED")
    return { kind: "closed", context: args.context, facts };
  const threads = await args.reader.reviewThreads(args.context);
  const checks = await resolveChecks(args.reader, args.context);
  const failed = nonEmpty(
    checks.checks.filter(
      (check): check is T.FailedCheck => check.kind === "failed"
    )
  );
  const pending = nonEmpty(
    checks.checks.filter(
      (check): check is T.PendingCheck => check.kind === "pending"
    )
  );
  let ci: T.CiState;
  if (failed === null && pending !== null && args.pendingHistory === "omit")
    ci = {
      kind: "ci-pending",
      source: checks.source,
      all: checks.checks,
      failed: [],
      pending,
      hadPreviousPassingCi: false,
    };
  else {
    const merge = await mergeAssessment(args.reader, facts);
    const base = {
      source: checks.source,
      all: checks.checks,
      hadPreviousPassingCi: merge.hadPreviousPassingCi,
    };
    if (failed !== null)
      ci = {
        ...base,
        kind: "ci-failing",
        failed,
        pending: pending ?? [],
        github: merge.github,
      };
    else if (merge.github.kind === "refused")
      ci = {
        ...base,
        kind: "ci-github-rejected",
        failed: [],
        pending: pending ?? [],
        github: merge.github,
      };
    else if (pending !== null)
      ci = { ...base, kind: "ci-pending", failed: [], pending };
    else
      ci = {
        ...base,
        kind: "ci-clean",
        failed: [],
        pending: [],
        github: merge.github,
      };
  }
  return {
    kind: "open",
    context: args.context,
    facts,
    threads,
    ci,
    reviewAutomationRunning: checks.checks.some(
      (check) =>
        check.kind === "pending" &&
        AUTOMATION_TOKENS.some((token) =>
          check.name.toLowerCase().includes(token)
        )
    ),
  };
}
const conflictBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.facts.mergeable === "CONFLICTING" ||
    row.facts.mergeStateStatus === "DIRTY" ||
    row.facts.mergeStateStatus === "CONFLICTING")
    ? { kind: "merge-conflicts", pr: row.context, facts: row.facts }
    : null;
function threadBlocker(row: T.PrSnapshot): T.MergeBlocker | null {
  if (row.kind !== "open") return null;
  const threads = nonEmpty(row.threads);
  return threads === null
    ? null
    : { kind: "review-threads", pr: row.context, threads };
}
const ciBlocker = (row: T.PrSnapshot): T.MergeBlocker | null =>
  row.kind === "open" &&
  (row.ci.kind === "ci-failing" || row.ci.kind === "ci-github-rejected")
    ? { kind: "failing-checks", pr: row.context, ci: row.ci }
    : null;
function gateReason(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeGateReason | null {
  if (row.kind === "merged") return null;
  if (row.kind === "closed") return "closed-without-merge";
  if (row.facts.isDraft && !allowDraft) return "draft-pr";
  return row.facts.reviewDecision === "CHANGES_REQUESTED"
    ? "changes-requested"
    : null;
}
function gateBlocker(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.MergeBlocker | null {
  const reason = gateReason(row, allowDraft);
  return reason === null ||
    (reason === "draft-pr" &&
      row.kind === "open" &&
      row.ci.kind === "ci-pending")
    ? null
    : { kind: "merge-gate", pr: row.context, reason };
}
function readyContribution(
  row: T.PrSnapshot,
  allowDraft: boolean
): T.ReadyPr | T.MergedPr | null {
  if (row.kind === "merged")
    return {
      kind: "merged-pr",
      context: row.context,
      mergedAt: row.facts.mergedAt,
    };
  if (
    row.kind !== "open" ||
    row.ci.kind !== "ci-clean" ||
    row.threads.length !== 0 ||
    conflictBlocker(row) !== null ||
    gateReason(row, allowDraft) !== null
  )
    return null;
  const reviewDecision = row.facts.reviewDecision;
  if (reviewDecision === "CHANGES_REQUESTED") return null;
  return {
    kind: "ready-pr",
    context: row.context,
    proof: {
      mergeability: "clear",
      threads: [],
      ci: row.ci,
      gate: {
        state: "OPEN",
        reviewDecision,
        draft: row.facts.isDraft ? "draft-allowed" : "not-draft",
      },
    },
  };
}
export function classifyPr(
  row: T.PrSnapshot,
  allowDraft = false
): T.PrDecision {
  for (const blocker of [
    conflictBlocker(row),
    threadBlocker(row),
    ciBlocker(row),
    gateBlocker(row, allowDraft),
  ])
    if (blocker !== null) return { kind: "blocker", blocker };
  if (row.kind === "open" && row.ci.kind === "ci-pending")
    return { kind: "waiting", frontier: row.context, pending: row.ci.pending };
  const ready = readyContribution(row, allowDraft);
  if (ready === null) throw new Error("snapshot has no classified decision");
  return ready.kind === "merged-pr"
    ? { kind: "merged", pr: ready }
    : { kind: "ready", pr: ready };
}
export function selectTierMajorStackDecision(
  rows: T.NonEmpty<T.PrSnapshot>,
  allowDraft = false
): T.StackDecision {
  for (const tier of [conflictBlocker, threadBlocker, ciBlocker])
    for (const row of rows) {
      const blocker = tier(row);
      if (blocker !== null) return { kind: "blocker", blocker };
    }
  for (const row of rows) {
    const blocker = gateBlocker(row, allowDraft);
    if (blocker !== null) return { kind: "blocker", blocker };
  }
  for (const row of rows)
    if (row.kind === "open" && row.ci.kind === "ci-pending")
      return {
        kind: "waiting",
        frontier: row.context,
        pending: row.ci.pending,
      };
  const prs = nonEmpty(
    rows
      .map((row) => readyContribution(row, allowDraft))
      .filter((row): row is T.ReadyPr | T.MergedPr => row !== null)
  );
  if (prs === null || prs.length !== rows.length)
    throw new Error("stack has no classified decision");
  return { kind: "clear", prs };
}
