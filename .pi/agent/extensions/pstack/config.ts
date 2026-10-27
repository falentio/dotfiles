/**
 * pstack settings. This file is the only settings source: no environment
 * variable, CLI flag, or other file is read.
 */

/** Steal the orchestrate store lock even when another process is alive. */
export const ORCH_FORCE_LOCK_STEAL = false;

/** Rows a tool result shows before it truncates with a more-hint. */
export const ORCH_DISPLAY_LIMIT = 4;

/** Newest session entries the compaction resume scan reads. */
export const COMPACTION_SCAN_LIMIT = 300;

/** Check names that mean a review bot is still running. */
export const REVIEW_AUTOMATION_TOKENS = [
  "bugbot",
  "security review",
  "pr review automation",
  "review automation",
] as const;

/** The owner-approval gate, which is never treated as a pending check. */
export const CODE_REVIEW_GATE_NAME = "Code Review Gate";

/** Author login substrings that mark a comment as Bugbot's. */
export const BUGBOT_AUTHOR_TOKENS = ["bugbot"] as const;

/** The automation author whose comments are Bugbot's only with a body token. */
export const BUGBOT_CURSOR_AUTHOR = "cursor";

/** Body tokens that mark a Cursor automation comment as Bugbot's. */
export const BUGBOT_BODY_TOKENS = [
  "bugbot",
  "cursor_automation_id",
  "agentic security review",
  "description start",
  "severity",
] as const;
