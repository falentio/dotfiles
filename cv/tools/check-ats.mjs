#!/usr/bin/env node
// ATS gate for cv/cv.typ. Rebuilds the PDF and asserts the properties a
// plain-text applicant tracking system depends on. Exits non-zero if any check
// fails.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcPath = join(root, "cv.typ");
const out = join(root, "out", "kevin-falentio-cv.pdf");
const cv = JSON.parse(readFileSync(join(root, "data", "cv.json"), "utf8"));
const layoutSource = readFileSync(srcPath, "utf8");

mkdirSync(dirname(out), { recursive: true });
execFileSync("typst", ["compile", srcPath, out], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});

// poppler warns about the Suspects flag typst writes; the exit code is the signal
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

const plain = sh("pdftotext", [out, "-"]);
const info = sh("pdfinfo", [out]);
const fonts = sh("pdffonts", [out]);
const lines = plain.split("\n").map((l) => l.trim());

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

// the heading set is fixed in the source, so a renamed heading fails here and
// not only in whatever the PDF happens to contain
const DOCUMENTED = ["Summary", "Skills", "Projects", "Open source"];
const headingsInSource = [...layoutSource.matchAll(/section-heading\(\s*"([^"]+)"/g)].map((m) => m[1]);
check(
  "source emits the documented headings in order",
  JSON.stringify(headingsInSource) === JSON.stringify(DOCUMENTED),
  `found ${JSON.stringify(headingsInSource)}`,
);

const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? "0");
check("fits one page", pages === 1, `pdfinfo reports ${pages} page(s)`);

const fontRows = fonts
  .trim()
  .split("\n")
  .slice(2)
  .filter((l) => l.trim() !== "");
const fontsEmbedded =
  fontRows.length > 0 && fontRows.every((r) => /\syes\s+yes\s/.test(` ${r} `));
check("every font is embedded and subset", fontsEmbedded, `${fontRows.length} font object(s)`);

const imageCount = sh("pdfimages", ["-list", out])
  .trim()
  .split("\n")
  .slice(2)
  .filter((l) => l.trim() !== "").length;
check("page carries no raster images", imageCount === 0, `pdfimages lists ${imageCount}`);

const banned = [/\bgrid\(/, /\btable\(/, /\bplace\(/, /float:\s*true/, /tracking:/, /smallcaps/];
const bannedFound = banned.filter((re) => re.test(layoutSource)).map((re) => String(re));
check("layout uses no column-breaking constructs", bannedFound.length === 0, bannedFound.join(", "));

const required = [
  cv.profile.name,
  cv.profile.email,
  ...cv.sections.at(0).groups.map((g) => g.label),
  ...cv.sections.at(1).projects.map((p) => p.name),
  ...cv.sections.at(2).items.map((i) => i.label),
];
for (const token of required) {
  check(`extracts "${token}"`, plain.includes(token));
}

// each heading must be a line of its own, so a variant like "Skills & Tools"
// cannot pass by containing "SKILLS"
const order = DOCUMENTED.map((h) => h.toUpperCase());
const upperLines = lines.map((l) => l.toUpperCase());
for (const heading of DOCUMENTED) {
  const token = heading.toUpperCase();
  const standalone = upperLines.filter((l) => l === token).length === 1;
  check(`heading "${heading}" is a standard whole line`, standalone);
}


const seen = upperLines.filter((l) => order.includes(l));
check("headings appear in reading order", JSON.stringify(seen) === JSON.stringify(order), JSON.stringify(seen));

const bulletOk = cv.sections.at(1).projects.every((p) =>
  p.bullets.every((b) => plain.replace(/\s+/g, " ").includes(b.replace(/\s+/g, " "))),
);
check("every bullet survives extraction", bulletOk);

const dateOk = cv.sections.at(1).projects.every((p) => {
  const shown = p.end === null ? `${p.start} to present` : `${p.start} to ${p.end}`;
  return lines.some((l) => l.startsWith(p.name) && l.includes(shown));
});
check("each date sits on its project name line", dateOk);

const contact = [cv.profile.email, ...cv.profile.urls.map((u) => u.value)];
check("contact line is not mangled", contact.every((c) => plain.includes(c)));

// a reader clicking a link must land somewhere
const urls = [
  ...cv.sections.at(1).projects.flatMap((p) => [p.url, p.homepage].filter((u) => u)),
  ...cv.profile.urls.map((u) => u.url),
];
const dead = urls.filter((u) => {
  const host = new URL(u).hostname;
  const resolved = sh("getent", ["hosts", host]);
  return resolved.trim() === "";
});
check("every URL on the CV resolves", dead.length === 0, dead.join(", "));

const bbox = sh("pdftotext", ["-bbox", out, "-"]);
const highs = [...bbox.matchAll(/yMax="([\d.]+)"/g)].map((m) => Number(m[1]));
const fill = highs.length ? Math.round((Math.max(...highs) / 841.89) * 100) : 0;
check("page is well filled", fill >= 60, `last baseline at ${fill}% of A4 height`);

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && !r.ok ? " -- " + r.detail : ""}`);
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed  (page ${fill}% filled, ${pages} page)`);
if (failures.length) {
  console.log("\nFAILED:\n" + failures.map((f) => "  " + f.name).join("\n"));
  process.exit(1);
}
