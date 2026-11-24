import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const digest = "a".repeat(64);
const database = `postgres:17-alpine@sha256:${digest}`;
const packages = ["@anthropic-ai/claude-code", "@openai/codex", "opencode-ai", "@google/gemini-cli", "@moonshot-ai/kimi-code"];

function check(t, { extraStage = "", image = `\"${database}\"`, extraService = "", version = "1.2.3", installed } = {}) {
  const root = mkdtempSync(join(tmpdir(), "proprio-image-pins-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "docker"));
  const script = join(root, "scripts/check-self-hosted-image-pins.mjs");
  copyFileSync(new URL("./check-self-hosted-image-pins.mjs", import.meta.url), script);
  writeFileSync(join(root, "Dockerfile"), [
    `FROM node:24@sha256:${digest} AS base`, extraStage, "FROM base AS production",
    `RUN true \\`, `  && npm install --global --omit=dev ${packages.map(name => `${name}@${version}`).join(" ")} \\`,
    "  && true", "",
  ].join("\n"));
  writeFileSync(join(root, "docker/docker-compose.yml"), `services:\n  db:\n    image: ${image}\n${extraService}`);
  return spawnSync(process.execPath, [script, ...(installed ? ["--installed"] : [])], {
    encoding: "utf8", input: installed && JSON.stringify({ dependencies: installed }),
  });
}

test("requires digests on external FROM lines with extra whitespace or no alias", (t) => {
  for (const extraStage of ["FROM  node:24 AS helper", "FROM node:24"]) {
    const result = check(t, { extraStage, image: database });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /External base.*must use an image digest/);
  }
});

test("checks the database service and accepts its quoted image reference", (t) => {
  const pinned = check(t);
  assert.equal(pinned.status, 0, pinned.stderr);
  const floating = check(t, { image: "postgres:17-alpine", extraService: `  other:\n    image: ${database}\n` });
  assert.notEqual(floating.status, 0);
  assert.match(floating.stderr, /Pin the full-stack PostgreSQL image digest/);
});

test("rejects mutable npm tags that resemble version prereleases", (t) => {
  for (const version of ["1.2.3-nightly_1", "1.2.3-rc..1", "01.2.3"]) {
    const result = check(t, { image: database, version });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pin an exact version/);
  }
  const pinned = check(t, { image: database, version: "1.2.3-rc.1" });
  assert.equal(pinned.status, 0, pinned.stderr);
});

test("rejects a final installed harness version that overwrote the declared pin", (t) => {
  const installed = Object.fromEntries(packages.map(name => [name, { version: "1.2.3" }]));
  installed["opencode-ai"].version = "1.2.4";
  const result = check(t, { image: database, installed });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Built image has the wrong version of opencode-ai/);
});
