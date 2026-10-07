import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { SessionDir } from "./session-dir.ts";

export type Bucket =
  | "hold-wip"
  | "hold-open-pr"
  | "verify-recent-chat"
  | "safe"
  | "review";

export interface WorktreeRow {
  readonly size: string;
  readonly age: string;
  readonly merged: string;
  readonly dirty: string;
  readonly remote: string;
  readonly pr: string;
  readonly lastChat: string;
  readonly bucket: Bucket;
  readonly worktree: string;
}

export interface ClassifyInput {
  readonly dirty: string;
  readonly pr: string;
  readonly recent: boolean;
  readonly merged: boolean;
}

function isWipDirty(dirty: string): boolean {
  return dirty.startsWith("wip:");
}

function isOpenPr(pr: string): boolean {
  return pr.includes("OPEN");
}

export function classifyRow({ dirty, pr, recent, merged }: ClassifyInput): Bucket {
  if (isWipDirty(dirty)) return "hold-wip";
  if (isOpenPr(pr)) return "hold-open-pr";
  if (recent) return "verify-recent-chat";
  if (merged || pr !== "-") return "safe";
  return "review";
}

export const WORKTREE_AUDIT_HEADER =
  "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE";

export function formatTable(rows: readonly WorktreeRow[]): string {
  const lines = [WORKTREE_AUDIT_HEADER];
  for (const row of rows) {
    lines.push(
      [
        row.size,
        row.age,
        row.merged,
        row.dirty,
        row.remote,
        row.pr,
        row.lastChat,
        row.bucket,
        row.worktree,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

export function parseHumanSize(size: string): number {
  const match = /^([\d.]+)([KMGTPE]?)$/.exec(size.trim().toUpperCase());
  if (match?.[1] === undefined) return Number.NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return Number.NaN;
  const unit = match[2] ?? "";
  const factor: Record<string, number> = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
    E: 1024 ** 6,
  };
  return value * (factor[unit] ?? Number.NaN);
}

interface GhPrRow {
  readonly number: number;
  readonly state: string;
  readonly headRefName: string;
}

function runCmd(file: string, args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync(file, [...args], {
      cwd,
      encoding: "utf8",
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function runGit(args: readonly string[], cwd: string): string | null {
  return runCmd("git", args, cwd);
}

function gitOk(args: readonly string[], cwd: string): boolean {
  return runGit(args, cwd) !== null;
}

function resolveRepo(raw: string | undefined, directory: string): string {
  if (raw !== undefined) return isAbsolute(raw) ? raw : resolve(directory, raw);
  const top = runGit(["rev-parse", "--show-toplevel"], directory)?.trim();
  return top !== undefined && top.length > 0 ? top : directory;
}

function listWorktrees(repo: string): string[] {
  const out = runGit(["worktree", "list", "--porcelain"], repo);
  if (out === null) throw new Error("not in a git repo; pass a repo path");
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length).trim());
  }
  return paths;
}

function dirtyFromPorcelain(porcelain: string): string {
  if (porcelain.trim() === "") return "clean";
  const lines = porcelain.split("\n").filter((line) => line.length > 0);
  const tracked = lines.filter((line) => !line.startsWith("??"));
  if (tracked.length > 0) return `wip:${tracked.length}`;
  return `scratch:${lines.length}`;
}

function remoteFor(worktree: string, branch: string, head: string, repo: string): string {
  if (branch === "") return "detached";
  if (!gitOk(["-C", worktree, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repo)) {
    return "no-remote";
  }
  const originSha = runGit(["-C", worktree, "rev-parse", `origin/${branch}`], repo)?.trim() ?? "";
  if (originSha !== "" && originSha === head) return "pushed";
  const count = runGit(["-C", worktree, "rev-list", "--count", `origin/${branch}..HEAD`], repo)?.trim() ?? "";
  return `ahead${count}`;
}

function loadPrMap(repo: string): Map<string, string> {
  const out = runCmd(
    "gh",
    ["pr", "list", "--author", "@me", "--state", "all", "--limit", "1000", "--json", "number,state,headRefName"],
    repo,
  );
  if (out === null) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) return new Map();
  const map = new Map<string, string>();
  for (const entry of parsed) {
    const row = entry as Partial<GhPrRow>;
    if (typeof row.number !== "number" || typeof row.state !== "string" || typeof row.headRefName !== "string") continue;
    if (!map.has(row.headRefName)) map.set(row.headRefName, `#${row.number}/${row.state}`);
  }
  return map;
}

function auditRepo(repo: string, recentWorktrees: readonly string[] = []): string {
  const fetchOk =
    runCmd("git", ["fetch", "origin", "main", "--quiet"], repo) !== null;
  const prs = loadPrMap(repo);
  const all = listWorktrees(repo);
  const main = all[0];
  const rest = main === undefined ? [] : all.slice(1);
  const now = Math.floor(Date.now() / 1000);
  const recent = new Set(recentWorktrees);
  const rows: WorktreeRow[] = [];
  for (const wt of rest) {
    const size = runCmd("du", ["-sh", wt], repo)?.split(/\s+/)[0] ?? "?";
    const head = runGit(["-C", wt, "rev-parse", "HEAD"], repo)?.trim() ?? "";
    const headTsRaw = runGit(["-C", wt, "log", "-1", "--format=%ct", "HEAD"], repo)?.trim() ?? "";
    const headTs = Number.parseInt(headTsRaw, 10);
    const age = Number.isSafeInteger(headTs) && headTs > 0 ? `${Math.floor((now - headTs) / 86400)}d` : "?";
    // Squash merges never become ancestors of main, so this flag only catches fast-forward and rebase merges. PR state remains the real merged signal.
    const merged = head !== "" && gitOk(["merge-base", "--is-ancestor", head, "origin/main"], repo) ? "YES" : "no";
    const porcelain = runGit(["-C", wt, "status", "--porcelain"], repo) ?? "";
    const dirty = dirtyFromPorcelain(porcelain);
    const branch = runGit(["-C", wt, "symbolic-ref", "--quiet", "--short", "HEAD"], repo)?.trim() ?? "";
    const remote = remoteFor(wt, branch, head, repo);
    const pr = branch !== "" ? (prs.get(branch) ?? "-") : "-";
    const isRecent = recent.has(wt);
    const bucket = classifyRow({ dirty, pr, recent: isRecent, merged: merged === "YES" });
    rows.push({ size, age, merged, dirty, remote, pr, lastChat: isRecent ? "recent" : "-", bucket, worktree: wt });
  }
  rows.sort((a, b) => {
    const left = parseHumanSize(a.size);
    const right = parseHumanSize(b.size);
    if (Number.isNaN(left) && Number.isNaN(right)) return 0;
    if (Number.isNaN(left)) return 1;
    if (Number.isNaN(right)) return -1;
    return right - left;
  });
  const table = formatTable(rows);
  if (fetchOk) return table;
  return `warn: could not fetch origin/main; merged column may be stale\n${table}`;
}

export function buildWorktreeAuditTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_worktree_audit",
    description:
      "Read-only worktree prune audit. Lists non-main worktrees as TSV with SIZE, AGE, MERGED, DIRTY, REMOTE, PR, LAST_CHAT, BUCKET, WORKTREE sorted by SIZE descending like the legacy script. Runs a best-effort git fetch origin main first; a fetch failure prefixes a stale-merge warning. LAST_CHAT is recent when the worktree is in recentWorktrees, else -. Pass session-derived worktree paths via recentWorktrees. Shells only to git, du, and gh.",
    input: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repository directory, absolute or relative to the session directory. Defaults to the session repo top level." },
        recentWorktrees: { type: "array", items: { type: "string" }, description: "Worktree paths touched recently; they map to LAST_CHAT recent and the verify-recent-chat bucket." },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(input: { repo?: string; recentWorktrees?: string[] }, context: { sessionID: string }) {
      const directory = await deps.sessionDir(context.sessionID);
      const repo = resolveRepo(input.repo, directory);
      return { content: auditRepo(repo, input.recentWorktrees ?? []) };
    },
  };
}
