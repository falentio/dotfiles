#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const OWNER = process.env.GH_OWNER ?? "falentio";
const OUT = new URL("../data/github.json", import.meta.url);
const README_LIMIT = 1200;

const gh = (args) => JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 }));

const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");

const excerpt = (text) => {
  const cut = text.slice(0, README_LIMIT).trim();
  return cut.length < text.trim().length ? `${cut}\n…` : cut;
};

const pick = (repo) => ({
  name: repo.name,
  url: repo.html_url,
  description: repo.description ?? "",
  primary_language: repo.language ?? "",
  stars: repo.stargazers_count,
  forks: repo.forks_count,
  created_at: repo.created_at.slice(0, 10),
  pushed_at: repo.pushed_at.slice(0, 10),
  topics: repo.topics ?? [],
});

const profile = gh(["api", `users/${OWNER}`, "--jq", "{login,name,html_url,public_repos,followers,following,created_at}"]);

const repos = gh(["api", `users/${OWNER}/repos?per_page=100`, "--jq", "[.[] | select(.fork == false)]"]);

const picked = repos.map(pick);

for (const repo of picked) {
  const langs = gh(["api", `repos/${OWNER}/${repo.name}/languages`]);
  repo.languages = Object.entries(langs)
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .map((l) => l.name)
    .slice(0, 3);

  const readme = (() => {
    try {
      return decode(gh(["api", `repos/${OWNER}/${repo.name}/readme`, "--jq", ".content"]));
    } catch {
      return "";
    }
  })();
  repo.readme = readme ? excerpt(readme) : "";
}

const payload = {
  generated_at: new Date().toISOString(),
  owner: OWNER,
  profile,
  repos: picked.sort((a, b) => b.pushed_at.localeCompare(a.pushed_at)),
};

await import("node:fs/promises").then((fs) =>
  fs.writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`),
);

const counts = new Map();
for (const repo of picked) for (const l of repo.languages) counts.set(l, (counts.get(l) ?? 0) + 1);

console.log(`wrote ${OUT.pathname}: ${picked.length} repos`);
console.log(`\nlanguages: ${[...counts].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ")}`);
console.log(`\nrecently pushed:`);
for (const r of picked.slice(0, 15)) {
  console.log(`  ${r.pushed_at}  ${String(r.stars).padStart(2)}*  ${r.name}  [${r.languages.join(", ")}]`);
}
console.log(`\nmost starred:`);
for (const r of [...picked].sort((a, b) => b.stars - a.stars).slice(0, 8)) {
  console.log(`  ${String(r.stars).padStart(2)}*  ${r.name}  (${r.primary_language || "-"})`);
}
