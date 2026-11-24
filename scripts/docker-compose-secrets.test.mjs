import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const baseEnv = Object.fromEntries(
  ["PATH", "HOME", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const compose = spawnSync("docker", ["compose", "version"], { env: baseEnv });
assert.equal(compose.status, 0, "Docker Compose is required for this integration check.");

const quickstart = "docker/docker-compose.quickstart.yml";
const fullStack = "docker/docker-compose.yml";
const loopbackDatabase = "docker/docker-compose.local-postgres.yml";
const envExample = readFileSync(path.join(repoRoot, "docker/.env.compose.example"), "utf8");
const testValues = {
  BETTER_AUTH_SECRET: "session-test-value",
  PROPRIO_TOOL_ACTION_SIGNING_SECRET: "tool-test-value",
  PROPRIO_POSTGRES_PASSWORD: "0123456789abcdef",
};

function renderCompose(t, files, values) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "proprio-compose-config-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const envFile = path.join(temporary, "compose.env");
  const valuesFromExample = envExample.replace(/^([A-Z_]+)=$/gm, (line, name) => {
    return Object.hasOwn(values, name) ? `${name}=${values[name]}` : line;
  });
  writeFileSync(envFile, valuesFromExample);
  const overrides = Object.fromEntries(Object.entries(values).filter(([name]) => !Object.hasOwn(testValues, name)));
  return spawnSync("docker", [
    "compose", "--env-file", envFile, ...files.flatMap((file) => ["-f", file]), "config", "--format", "json",
  ], { cwd: repoRoot, env: { ...baseEnv, ...overrides }, encoding: "utf8" });
}

function services(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).services;
}

for (const [file, service] of [[quickstart, "proprio"], [fullStack, "server"]]) {
  test(`${file} uses the documented setup and production target`, (t) => {
    const model = services(renderCompose(t, [file], testValues));
    const app = model[service];
    assert.equal(app.build.target, "production");
    assert.deepEqual(app.ports.map(({ host_ip, published, target }) => [host_ip, published, target]), [
      ["127.0.0.1", "3100", 3100],
    ]);
    assert.equal(app.environment.PROPRIO_PUBLIC_URL, "http://localhost:3100");
    assert.equal(app.environment.BETTER_AUTH_SECRET, testValues.BETTER_AUTH_SECRET);
    assert.equal(app.environment.PROPRIO_TOOL_ACTION_SIGNING_SECRET, testValues.PROPRIO_TOOL_ACTION_SIGNING_SECRET);

    const legacyModel = services(renderCompose(t, [file], { ...testValues, PROPRIO_TOOL_ACTION_SIGNING_SECRET: "" }));
    assert.equal(legacyModel[service].environment.PROPRIO_TOOL_ACTION_SIGNING_SECRET, "");

    const extraHostname = "other.example.test";
    const customModel = services(renderCompose(t, [file], {
      ...testValues, PROPRIO_PORT: "3200", PROPRIO_ALLOWED_HOSTNAMES: extraHostname,
    }));
    assert.equal(customModel[service].ports[0].published, "3200");
    assert.equal(customModel[service].environment.PROPRIO_PUBLIC_URL, "http://localhost:3200");
    assert.equal(customModel[service].environment.PROPRIO_ALLOWED_HOSTNAMES, extraHostname);

    const explicitModel = services(renderCompose(t, [file], {
      ...testValues, PROPRIO_BIND_IP: "192.0.2.10", PROPRIO_PUBLIC_URL: "https://proprio.example.test",
    }));
    assert.equal(explicitModel[service].ports[0].host_ip, "192.0.2.10");
    assert.equal(explicitModel[service].environment.PROPRIO_PUBLIC_URL, "https://proprio.example.test");
  });
}

test("full-stack database requires its own password and stays private by default", (t) => {
  const noPassword = renderCompose(t, [fullStack], { ...testValues, PROPRIO_POSTGRES_PASSWORD: "" });
  assert.notEqual(noPassword.status, 0);
  assert.match(noPassword.stderr, /Set PROPRIO_POSTGRES_PASSWORD/);

  const defaultModel = services(renderCompose(t, [fullStack], testValues));
  assert.equal(defaultModel.db.ports, undefined);
  assert.equal(defaultModel.db.environment.POSTGRES_PASSWORD, testValues.PROPRIO_POSTGRES_PASSWORD);
  const databaseUrl = new URL(defaultModel.server.environment.DATABASE_URL);
  assert.equal(databaseUrl.hostname, "db");
  assert.equal(databaseUrl.password, testValues.PROPRIO_POSTGRES_PASSWORD);

  const override = services(renderCompose(t, [fullStack, loopbackDatabase], {
    ...testValues, PROPRIO_POSTGRES_PORT: "5544",
  }));
  assert.deepEqual(override.db.ports.map(({ host_ip, published, target }) => [host_ip, published, target]), [
    ["127.0.0.1", "5544", 5432],
  ]);
});

test("both application health probes wait for a ready body", async (t) => {
  const quick = services(renderCompose(t, [quickstart], testValues)).proprio.healthcheck;
  const full = services(renderCompose(t, [fullStack], testValues)).server.healthcheck;
  assert.deepEqual(quick, full);
  const [mode, executable, ...args] = quick.test;
  assert.equal(mode, "CMD");
  assert.equal(executable, "node");

  let status = "starting";
  const health = createServer((_request, response) => response.end(JSON.stringify({ status })));
  await new Promise((resolve) => health.listen(0, "127.0.0.1", resolve));
  t.after(() => health.close());
  const probe = () => promisify(execFile)(process.execPath, args.map((arg) =>
    arg.replace("127.0.0.1:3100", `127.0.0.1:${health.address().port}`)));
  await assert.rejects(probe(), { code: 1 });
  status = "ok";
  await probe();
});
