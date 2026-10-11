#!/usr/bin/env node
// ATS gate for cv/cv.typ. Rebuilds the PDF and asserts the things a
// plain-text parser depends on. Exits non-zero on the first failed check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const src = join(root, "cv.typ");
const out = join(root, "out", "kevin-falentio-cv.pdf");
const cv = JSON.parse(readFileSync(join(root, "data", "cv.json"), "utf8"));

execFileSync("typst", ["compile", src, out], { cwd: root, stdio: "inherit" });

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const plain = sh("pdftotext", [out, "-"]);
const layout = sh("pdftotext", ["-layout", out, "-"]);
const info = sh("pdfinfo", [out]);

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? "0");
check("fits one page", pages === 1, `pdfinfo reports ${pages} page(s)`);

const fonts = sh("pdffonts", [out]);
check("fonts are embedded", !/\bno\b/.test(fonts), fonts.trim().split("\n").slice(2).join(" | "));

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

// a parser sees the flattened line stream; the order below is the reading order
const order = [cv.profile.name, "SUMMARY", "SKILLS", "PROJECTS", "OPEN SOURCE"];
let cursor = 0;
let ordered = true;
for (const token of order) {
  const at = plain.toUpperCase().indexOf(token.toUpperCase(), cursor);
  if (at === -1) {
    ordered = false;
    break;
  }
  cursor = at + token.length;
}
check("sections appear in reading order", ordered, order.join(" > "));

// a bullet split across two lines by the parser must still join to the source text
const bulletOk = cv.sections.at(1).projects.every((p) =>
  p.bullets.every((b) => plain.replace(/\s+/g, " ").includes(b.replace(/\s+/g, " "))),
);
check("every bullet survives extraction", bulletOk);

// date strings must remain machine parseable, not decorative
const dateOk = cv.sections.at(1).projects.every((p) => {
  const end = p.end ?? null;
  const shown = end === null ? p.start : `${p.start} to ${p.end}`;
  return plain.includes(shown);
});
check("dates are parseable text", dateOk);

// no ligature, small-caps, or letter-spacing corruption of the contact line
const contact = [cv.profile.email, ...cv.profile.urls.map((u) => u.value)];
const contactOk = contact.every((c) => plain.includes(c));
check("contact line is not mangled", contactOk);

// the page should be substantially used, not a near-empty sheet
const boxes = sh("pdftotext", ["-bbox", out, "-"], { stdio: ["ignore", "pipe", "ignore"] });
const lows = [...boxes.matchAll(/yMin="([\d.]+)"/g)].map((m) => Number(m[1]));
const highs = [...boxes.matchAll(/yMax="([\d.]+)"/g)].map((m) => Number(m[1]));
const last = highs.length ? Math.max(...highs) : 0;
const fill = Math.round((last / 841.89) * 100);
check("page is well filled", fill >= 60, `last baseline at ${fill}% of A4 height`);

// a parser that treats the page as an image, or meets an unembedded glyph,
// drops the whole CV
const imageCount = Number(
  sh("pdfimages", ["-list", out])
    .trim()
    .split("\n")
    .slice(2)
    .filter((l) => l.trim() !== "").length,
);
check("page carries no raster images", imageCount === 0, `pdfimages lists ${imageCount}`);

const fontLines = fonts
  .trim()
  .split("\n")
  .slice(2)
  .filter((l) => l.trim() !== "");
const allSubset = fontLines.length > 0 && fontLines.every((l) => /\syes\s/.test(l));
check("every font is embedded and subset", allSubset, `${fontLines.length} font object(s)`);

const failures = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail && !r.ok ? " -- " + r.detail : ""}`);
}
console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
if (failures.length) {
  console.log("\nFAILED:\n" + failures.map((f) => "  " + f.name).join("\n"));
  process.exit(1);
}
console.log("layout text (first 12 lines):\n" + layout.split("\n").slice(0, 12).join("\n"));
