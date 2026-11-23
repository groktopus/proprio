import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const home = process.env.PROPRIO_HOME;
assert(home, "Set PROPRIO_HOME to a disposable directory");
await mkdir(home, { recursive: true });
const trace = join(home, "network.log");
const receipt = join(home, "synthetic-run.txt");
const port = 33107;
const origin = `http://127.0.0.1:${port}`;
const server = spawn("strace", [
  "-D", "-f", "-s", "64", "-e", "trace=connect,sendto,sendmsg,sendmmsg", "-o", trace,
  process.execPath, "--import", "tsx", "dist/index.js",
], {
  cwd: fileURLToPath(new URL("../../server/", import.meta.url)),
  stdio: "inherit",
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
});
const closed = new Promise((resolve, reject) => {
  server.once("error", reject);
  server.once("close", resolve);
});
void closed.catch(() => undefined);

async function api(path, body) {
  const response = await fetch(`${origin}/api${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
    ...(body ? {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(body),
    } : {}),
  });
  assert(response.ok, `${path} returned ${response.status}: ${await response.clone().text()}`);
  return response.json();
}

async function waitFor(probe, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline && server.exitCode === null && server.signalCode === null) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Waiting for ${label} failed (server exit ${server.exitCode ?? server.signalCode ?? "pending"})`, { cause: lastError });
}

try {
  await waitFor(async () => (await api("/health")).status === "ok", "HTTP health", 90_000);
  const ui = await fetch(origin, { signal: AbortSignal.timeout(3_000) });
  assert(ui.ok && ui.headers.get("content-type")?.includes("text/html"), "The built server must serve the UI");
  const company = await api("/companies", { name: "Linux qualification fixture" });
  const agent = await api(`/companies/${company.id}/agents`, {
    name: "Synthetic agent",
    role: "ceo",
    adapterType: "process",
    adapterConfig: {
      command: process.execPath,
      args: ["-e", "require('node:fs').appendFileSync(process.argv[1], 'executed\\n')", receipt],
    },
  });
  const run = await api(`/agents/${agent.id}/wakeup`, { source: "on_demand", reason: "Linux source qualification" });
  assert(run.id, "The synthetic wake must create a heartbeat run");
  const terminal = await waitFor(async () => {
    const result = await api(`/heartbeat-runs/${run.id}`);
    return ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(result.status) ? result : null;
  }, "synthetic agent completion", 45_000);
  assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));
  assert.equal(await readFile(receipt, "utf8"), "executed\n");
  console.log(`Source HTTP service, UI, and synthetic agent verified (${run.id}).`);
} finally {
  server.kill("SIGTERM");
  const shutdownTimer = setTimeout(() => server.kill("SIGKILL"), 15_000);
  try {
    await closed;
  } finally {
    clearTimeout(shutdownTimer);
  }
}

const calls = (await readFile(trace, "utf8")).split("\n");
const external = calls.filter(line =>
  /sa_family=AF_INET6?[,}]/.test(line) &&
  !/inet_addr\("127\.\d+\.\d+\.\d+"\)|inet_pton\(AF_INET6, "(?:::1|::ffff:127\.\d+\.\d+\.\d+)"/.test(line));
assert.equal(external.length, 0, `Non-loopback network attempts from the server process tree:\n${external.join("\n")}`);
console.log("No non-loopback IPv4 or IPv6 connects or sends in the observed server process tree.");
