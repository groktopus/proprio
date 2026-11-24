import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../proprio-commit-metrics.ts", import.meta.url));

test("metrics combines current and historical trailers and honors an explicit query", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "proprio-metrics-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "mock-search.mjs");
  writeFileSync(preload, `
    const matches = new Map([
      ['"Co-Authored-By: Proprio <noreply@groktop.us>"', ["current", "shared", "quoted"]],
      ['"Co-Authored-By: Proprio <proprio@users.noreply.github.com>"', ["github", "shared"]],
      ['"Co-Authored-By: Proprio <noreply@paperclip.ing>"', ["legacy"]],
      ["repo:sample/other explicit", ["override"]],
    ]);
    const current = "Co-Authored-By: Proprio <noreply@groktop.us>";
    const github = "Co-Authored-By: Proprio <proprio@users.noreply.github.com>";
    const legacy = "Co-Authored-By: Proprio <noreply@paperclip.ing>";
    const human = "Co-Authored-By: Human Contributor <human@example.com>";
    const bot = "Co-Authored-By: Build Bot <noreply@groktop.us>";
    const messages = {
      current: "Current\\n\\n" + [current, human].join("\\n"),
      github: "Historical\\n\\n" + github,
      shared: "Shared\\n\\n" + [current, github].join("\\n"),
      legacy: "Legacy\\n\\n" + legacy,
      quoted: "Example\\n\\nUse this attribution:\\n" + current,
      override: "Explicit match\\n\\n" + [bot, human].join("\\n"),
    };
    const repo = { full_name: "sample/proprio", html_url: "https://github.com/sample/proprio" };
    globalThis.fetch = async (url) => {
      if (process.env.FAIL_ON_REQUEST === "1") throw new Error("Expected cached search results");
      const parsed = new URL(url);
      const query = parsed.searchParams.get("q");
      const suffix = " committer-date:2026-11-01T00:00:00Z..2026-11-25T00:00:00Z is:public";
      if (parsed.pathname !== "/search/commits" || !query?.endsWith(suffix)) {
        throw new Error("Unexpected request: " + url);
      }
      const shas = matches.get(query.slice(0, -suffix.length));
      if (!shas) throw new Error("Unexpected query: " + query);
      return Response.json({
        total_count: shas.length,
        incomplete_results: false,
        items: shas.map((sha) => ({
          author: null,
          commit: { author: null, message: messages[sha] },
          html_url: repo.html_url + "/commit/" + sha,
          repository: repo,
          sha,
        })),
      });
    };
  `);

  const cacheFile = path.join(dir, "cache.json");
  const legacyKey = JSON.stringify({
    query: '"Co-Authored-By: Proprio <proprio@users.noreply.github.com>"',
    searchField: "committer-date",
    visibility: "public",
  });
  writeFileSync(cacheFile, JSON.stringify({
    version: 1, queryKey: legacyKey, searchField: "committer-date", commits: {}, windows: {},
    stats: { github: { additions: 18, deletions: 7, total: 25 } },
  }));
  const run = (args = [], env = {}) => JSON.parse(execFileSync(process.execPath, [
    "--import", preload, script, "--json", "--skip-stats",
    "--start", "2026-11-01", "--end", "2026-11-25",
    "--cache-file", cacheFile, ...args,
  ], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_TOKEN: "fixture-token", ...env },
  }));

  const result = run();
  assert.equal(result.totals.commits, 4);
  assert.equal(result.detectedQuery.split("\n").length, 3);
  assert.equal(result.lineStats.totalChanges, 25);
  assert.deepEqual(result.contributors.sample.map(({ email }) => email), ["human@example.com"]);
  assert.equal(run([], { FAIL_ON_REQUEST: "1" }).totals.commits, 4);

  const override = run(["--query", "repo:sample/other explicit"]);
  assert.equal(override.totals.commits, 1);
  assert.match(override.detectedQuery, /^repo:sample\/other explicit committer-date:/);
  assert.equal(override.detectedQuery.split("\n").length, 1);
  assert.deepEqual(override.contributors.sample.map(({ email }) => email), ["human@example.com"]);

  const oldOverrideCache = JSON.parse(readFileSync(cacheFile, "utf8"));
  oldOverrideCache.commits.override.contributors.push({
    displayName: "Build Bot", email: "noreply@groktop.us", login: null, key: "email:noreply@groktop.us",
  });
  writeFileSync(cacheFile, JSON.stringify(oldOverrideCache));
  const warm = run(["--query", "repo:sample/other explicit"], { FAIL_ON_REQUEST: "1" });
  assert.deepEqual(warm.contributors, override.contributors);
});
