import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const compose = readFileSync(new URL("../docker/docker-compose.yml", import.meta.url), "utf8");
const digestPattern = /@sha256:[0-9a-f]{64}$/;
const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const stageNames = new Set();

for (const [, image, stage] of dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+) AS (\S+)$/gim)) {
  if (image !== "scratch" && !stageNames.has(image)) {
    assert.match(image, digestPattern, `External base for ${stage} must use an image digest`);
  }
  stageNames.add(stage);
}
assert.ok(stageNames.has("production"), "Missing self-hosted production stage");
assert.match(compose, /^    image: postgres:[^\s]+@sha256:[0-9a-f]{64}$/m, "Pin the full-stack PostgreSQL image digest");

const production = dockerfile.split(/^FROM base AS production$/m)[1]?.split(/^FROM /m)[0] ?? "";
const matches = [...production.matchAll(/^\s*&& npm install --global --omit=dev (.+) \\$/gm)];
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
