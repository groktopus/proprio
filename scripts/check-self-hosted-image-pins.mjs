import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const digestPattern = /@sha256:[0-9a-f]{64}$/;
const numeric = "(?:0|[1-9]\\d*)";
const identifier = `(?:${numeric}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const exactVersion = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`);
const stageNames = new Set();
const production = [];
let currentStage;

for (const line of dockerfile.split(/\r?\n/)) {
  if (!/^\s*FROM(?:\s|$)/i.test(line)) {
    if (currentStage === "production") production.push(line);
    continue;
  }
  const from = /^\s*FROM(?:\s+--\S+)*\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
  assert.ok(from, `Cannot parse Dockerfile FROM line: ${line}`);
  const [, image, stage] = from;
  const name = image.toLowerCase();
  if (name !== "scratch" && !stageNames.has(name)) {
    assert.match(image, digestPattern, `External base for ${stage ?? line.trim()} must use an image digest`);
  }
  currentStage = stage?.toLowerCase();
  if (currentStage) stageNames.add(currentStage);
}
assert.ok(stageNames.has("production"), "Missing self-hosted production stage");

const compose = JSON.parse(execFileSync("docker", [
  "compose", "--env-file", "/dev/null", "-f", "docker/docker-compose.yml", "config", "--format", "json",
], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    BETTER_AUTH_SECRET: "image-pin-check",
    PROPRIO_POSTGRES_PASSWORD: "image-pin-check",
  },
}));
assert.match(compose.services?.db?.image ?? "", /^(?:docker\.io\/library\/)?postgres:[^@\s]+@sha256:[0-9a-f]{64}$/,
  "Pin the full-stack PostgreSQL image digest");

const matches = [...production.join("\n").matchAll(/^\s*&& npm install --global --omit=dev (.+) \\$/gm)];
assert.equal(matches.length, 1, "Expected one production harness install line");
const versions = new Map();
for (const selector of matches[0][1].split(/\s+/)) {
  const delimiter = selector.lastIndexOf("@");
  const name = selector.slice(0, delimiter);
  const version = selector.slice(delimiter + 1);
  assert.ok(delimiter > 0 && exactVersion.test(version), `Pin an exact version for ${selector}`);
  assert.ok(!versions.has(name), `Repeated production harness ${name}`);
  versions.set(name, version);
}
for (const name of ["@anthropic-ai/claude-code", "@openai/codex", "opencode-ai", "@google/gemini-cli", "@moonshot-ai/kimi-code"]) {
  assert.ok(versions.has(name), `Missing production harness ${name}`);
}

const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--installed"), "Usage: node scripts/check-self-hosted-image-pins.mjs [--installed]");
if (args[0] === "--installed") {
  const { dependencies } = JSON.parse(readFileSync(0, "utf8"));
  for (const [name, version] of versions) {
    assert.equal(dependencies?.[name]?.version, version, `Built image has the wrong version of ${name}`);
  }
}
for (const [name, version] of versions) console.log(`${name}@${version}`);
