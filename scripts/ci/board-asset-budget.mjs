import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const dist = process.argv[2] ?? "ui/dist";
const manifest = JSON.parse(readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"));

// Hard ceilings rounded up from the b1873b02-era baseline remeasured at
// 98914d7c. Count every static dependency once per journey.
const budgets = {
  board: { raw: 3_860_000, gzip: 1_180_000 },
  task: { raw: 7_190_000, gzip: 2_120_000 },
};

function measure(entryKeys) {
  const files = new Set();
  const visited = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing Vite manifest entry ${key}`);
    if (entry.file.endsWith(".js")) files.add(entry.file);
    for (const imported of entry.imports ?? []) visit(imported);
  }
  for (const key of entryKeys) visit(key);
  if (files.size === 0) throw new Error("Board asset budget found no JavaScript files");
  const sizes = { raw: 0, gzip: 0 };
  for (const file of files) {
    const contents = readFileSync(path.join(dist, file));
    sizes.raw += contents.length;
    sizes.gzip += gzipSync(contents).length;
  }
  return sizes;
}

const entry = "index.html";
const detail = "src/pages/IssueDetail.tsx";
for (const [journey, roots] of [[ "board", [entry] ], [ "task", [entry, detail] ]]) {
  const measured = measure(roots);
  const budget = budgets[journey];
  console.log(`${journey}: ${measured.raw}/${budget.raw} bytes raw, ${measured.gzip}/${budget.gzip} bytes gzip`);
  if (measured.raw > budget.raw || measured.gzip > budget.gzip) {
    console.error(`The ${journey} JavaScript asset budget was exceeded.`);
    process.exitCode = 1;
  }
}
