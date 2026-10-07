import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SessionDir } from "./session-dir.ts";

type PlanLine = {
  n: number;
  text: string;
  code: boolean;
};

type PlanSection = {
  title: string;
  n: number;
  body: PlanLine[];
};

type PlanBox = {
  n: number;
  text: string;
};

type PlanDocument = {
  lines: PlanLine[];
  sections: PlanSection[];
};

type PlanSubBlock = {
  name: string;
  n: number;
  rest: string;
  lines: PlanLine[];
};

export type CheckResult = {
  reportLines: string[];
  problems: string[];
};

const VERIFICATION_RULE =
  "Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.";
const LIVE_LANES_PHRASE = "Ten lanes on the inherited parent model at the PR head";
const SUB_BLOCKS = [
  "Depends on.",
  "Files.",
  "Build.",
  "You see.",
  "Verify, unit.",
  "Verify, live.",
  "Verify, perf.",
  "Review gate.",
  "Merge.",
];
const PROGRAM_H3 = ["Arm the program", "Spawn owners", "PR mechanics", "Verdict and merge", "Boot recipe"];
const PROGRAM_MARKERS: Array<string | RegExp> = ["goal file", "git show origin/main:", /30[- ]minute/, "status message"];
const HOW_TO_READ_MARKERS = [
  "One box is one unit of work",
  "names the evidence",
  "Check a box only when its evidence exists",
  "playbooks/",
  VERIFICATION_RULE,
];
const PERF_ITEMS = ["Metric.", "Probe.", "Baseline.", "Rule."];
const CHECK_BOX_PATTERN = /^\s*- \[[ x]\] (.*)$/;

function parsePlanDocument(content: string): PlanDocument {
  const raw = content.split(/\r?\n/);
  let start = 0;
  if (raw[0] === "---") {
    start = raw.indexOf("---", 1) + 1;
  }
  const lines: PlanLine[] = [];
  let fence = false;
  for (let i = start; i < raw.length; i++) {
    const text = raw[i] ?? "";
    const n = i + 1;
    if (/^```/.test(text)) fence = !fence;
    lines.push({ n, text, code: fence });
  }
  const sections: PlanSection[] = [];
  for (const l of lines) {
    const title = !l.code && l.text.startsWith("## ") ? l.text.slice(3).trim() : null;
    if (title !== null) {
      sections.push({ title, n: l.n, body: [] });
    } else if (sections.length > 0) {
      const last = sections[sections.length - 1];
      if (last) last.body.push(l);
    }
  }
  return { lines, sections };
}

function collectBoxes(ls: PlanLine[]): PlanBox[] {
  const out: PlanBox[] = [];
  for (const l of ls) {
    if (l.code) continue;
    const m = l.text.match(CHECK_BOX_PATTERN);
    if (m?.[1] !== undefined) out.push({ n: l.n, text: m[1] });
  }
  return out;
}

function stripProse(text: string): string {
  return text
    .replace(/`[^`]*`/g, "`")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]");
}

export function checkPlanContent(content: string, fileLabel: string): CheckResult {
  const { lines, sections } = parsePlanDocument(content);
  const problems: string[] = [];
  const fail = (line: number, message: string): void => {
    problems.push(`${fileLabel}:${line}: ${message}`);
  };

  for (const l of lines) {
    if (l.code) continue;
    const prose = stripProse(l.text);
    if (/[\u2013\u2014]/.test(prose)) fail(l.n, "long dash");
    if (/[\u2018\u2019\u201c\u201d]/.test(prose)) fail(l.n, "curly quote");
    if (/: \S/.test(prose)) fail(l.n, "mid-sentence colon");
  }

  const find = (title: string): PlanSection | undefined => sections.find((s) => s.title === title);
  const bodyText = (s: PlanSection): string => s.body.map((l) => l.text).join("\n");

  const h1 = lines.findIndex((l) => !l.code && l.text.startsWith("# "));
  if (h1 === -1) fail(1, "no H1 title");
  const howToRead = find("How to read this");
  if (!howToRead) fail(1, 'no "## How to read this" section');
  if (h1 !== -1 && howToRead) {
    const h1Line = lines[h1];
    const intro = lines
      .slice(h1 + 1)
      .filter((l) => h1Line && l.n < howToRead.n && l.text.trim() !== "");
    if (h1Line && intro.length >= 10) fail(h1Line.n, `intro is ${intro.length} lines, under ten required`);
    for (const marker of HOW_TO_READ_MARKERS) {
      if (!bodyText(howToRead).includes(marker)) fail(howToRead.n, `How to read this lacks "${marker}"`);
    }
  }

  const program = find("Program checklist");
  if (!program) fail(1, 'no "## Program checklist" section');
  else {
    const h3s = program.body
      .filter((l) => !l.code && l.text.startsWith("### "))
      .map((l) => l.text.slice(4).trim());
    let cursor = 0;
    for (const name of PROGRAM_H3) {
      const at = h3s.findIndex((t, i) => i >= cursor && t.startsWith(name));
      if (at === -1) fail(program.n, `Program checklist lacks "### ${name}" in order`);
      else cursor = at + 1;
    }
    for (const marker of PROGRAM_MARKERS) {
      const ok = marker instanceof RegExp ? marker.test(bodyText(program)) : bodyText(program).includes(marker);
      if (!ok) fail(program.n, `Program checklist lacks "${marker}"`);
    }
  }

  const close = find("Close the program");
  if (!close) fail(1, 'no "## Close the program" section');
  const programIndex = program ? sections.indexOf(program) : -1;
  const closeIndex = close ? sections.indexOf(close) : -1;
  const prSections = programIndex === -1 || closeIndex === -1 ? [] : sections.slice(programIndex + 1, closeIndex);
  if (prSections.length === 0) fail(1, "no PR sections between Program checklist and Close the program");

  const reportLines: string[] = [];
  for (const pr of prSections) {
    if (!pr) continue;
    const heads: PlanSubBlock[] = [];
    for (const l of pr.body) {
      if (l.code) continue;
      const m = l.text.match(/^\*\*([^*]+)\*\*(.*)$/);
      if (m?.[1] !== undefined && m?.[2] !== undefined && SUB_BLOCKS.includes(m[1])) {
        heads.push({ name: m[1], n: l.n, rest: m[2].trim(), lines: [] });
      } else if (heads.length > 0) {
        heads[heads.length - 1]?.lines.push(l);
      }
    }
    const names = heads.map((h) => h.name);
    if (names.join("|") !== SUB_BLOCKS.join("|")) {
      fail(pr.n, `${pr.title}: sub-blocks are [${names.join(", ")}], expected [${SUB_BLOCKS.join(", ")}]`);
    }
    const block = (name: string): PlanSubBlock | undefined => heads.find((h) => h.name === name);
    const counts: Record<string, number> = {};
    for (const h of heads) counts[h.name] = collectBoxes(h.lines).length;

    const depends = block("Depends on.");
    if (depends && depends.rest === "") fail(depends.n, `${pr.title}: Depends on names nothing`);
    for (const name of ["Files.", "Build.", "You see.", "Verify, unit.", "Merge."]) {
      const b = block(name);
      if (b && collectBoxes(b.lines).length === 0) fail(b.n, `${pr.title}: ${name} has no box`);
    }
    for (const name of ["Verify, unit.", "Verify, live.", "Verify, perf."]) {
      const b = block(name);
      if (b && !b.rest.startsWith(VERIFICATION_RULE)) fail(b.n, `${pr.title}: ${name} does not open with the rule`);
    }

    const live = block("Verify, live.");
    if (live) {
      if (!live.rest.includes(LIVE_LANES_PHRASE)) fail(live.n, `${pr.title}: Verify, live lacks "${LIVE_LANES_PHRASE}"`);
      const lanes = collectBoxes(live.lines).map((b) => ({ ...b, m: b.text.match(/^Lane (\d+)\. /) }));
      const numbers = lanes
        .filter((b) => b.m)
        .map((b) => Number((b.m as RegExpMatchArray)[1]))
        .sort((a, b) => a - b);
      if (numbers.join(",") !== "1,2,3,4,5,6,7,8,9,10")
        fail(live.n, `${pr.title}: lanes are [${numbers.join(",")}], expected 1 to 10`);
      for (const lane of lanes) {
        if (!lane.m) fail(lane.n, `${pr.title}: live box is not a lane`);
        else if (!/Save `[^`]+`/.test(lane.text)) fail(lane.n, `${pr.title}: lane ${lane.m[1]} names no screenshot`);
        else if (!lane.text.includes("Pass when")) fail(lane.n, `${pr.title}: lane ${lane.m[1]} has no pass predicate`);
      }
    }

    const perf = block("Verify, perf.");
    if (perf) {
      const items = collectBoxes(perf.lines).map((b) => b.text.split(" ")[0] ?? "");
      if (items.join("|") !== PERF_ITEMS.join("|"))
        fail(perf.n, `${pr.title}: perf boxes are [${items.join(", ")}], expected [${PERF_ITEMS.join(", ")}]`);
    }

    const gate = block("Review gate.");
    if (gate) {
      const gateBoxes = collectBoxes(gate.lines);
      if (gate.rest.startsWith("None.")) {
        if (gateBoxes.length) fail(gate.n, `${pr.title}: Review gate says None but has boxes`);
      } else {
        const text = gate.lines.map((l) => l.text).join("\n");
        if (gateBoxes.length === 0) fail(gate.n, `${pr.title}: Review gate has no box`);
        for (const word of ["screenshot", "video", "operator"]) {
          if (!text.includes(word)) fail(gate.n, `${pr.title}: Review gate lacks "${word}"`);
        }
      }
    }

    const total = collectBoxes(pr.body).length;
    const cells = SUB_BLOCKS.filter((s) => s !== "Depends on.").map(
      (s) => `${s.replace(/[ ,.]+/g, "-").replace(/-$/, "").toLowerCase()}=${counts[s] ?? 0}`,
    );
    reportLines.push(`${pr.title}  boxes=${total}  ${cells.join(" ")}`);
  }

  if (closeIndex !== -1 && close) {
    const tail = sections.slice(closeIndex + 1);
    for (const s of tail) {
      if (!s.title.startsWith("Appendix")) fail(s.n, `"## ${s.title}" after Close the program is not an appendix`);
    }
    if (!tail.some((s) => s.title.includes("Prototype evidence")))
      fail(close.n, 'no "## Appendix ... Prototype evidence" section');
  }

  return { reportLines, problems };
}

export function buildCheckPlanTool(deps: { sessionDir: SessionDir }) {
  return {
    name: "poteto_check_plan",
    description:
      "Check a poteto multi-phase plan file for required shape, verification rule, lanes, perf items, and review gates. Reports problems inline; a non-zero problem count means the plan failed.",
    input: {
      type: "object",
      properties: {
        path: { type: "string", description: "Plan markdown path, absolute or relative to the session directory." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    async execute(input: { path: string }, context: { sessionID: string }) {
      const directory = await deps.sessionDir(context.sessionID);
      const resolved = isAbsolute(input.path) ? input.path : resolve(directory, input.path);
      let text: string;
      try {
        text = readFileSync(resolved, "utf8");
      } catch {
        throw new Error(`Cannot read plan file at ${resolved}.`);
      }
      const result = checkPlanContent(text, input.path);
      const summary = `${result.reportLines.length} PR sections, ${result.problems.length} problems`;
      return { content: [...result.reportLines, summary, ...result.problems].join("\n") };
    },
  };
}
