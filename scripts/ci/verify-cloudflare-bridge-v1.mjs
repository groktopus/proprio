import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const scratch = await mkdtemp(join(tmpdir(), "proprio-cloudflare-v1-"));
const port = "18787";
const base = `http://127.0.0.1:${port}/api/proprio-sandbox/v1`;
const token = "local-bridge-fixture";
const worker = spawn(process.execPath, [
  "node_modules/wrangler/bin/wrangler.js",
  "dev", "--local", "--ip", "127.0.0.1", "--port", port,
  "--show-interactive-dev-session=false", "--config", "wrangler.v1.jsonc",
  "--persist-to", join(scratch, "state"), "--var", `BRIDGE_AUTH_TOKEN:${token}`,
], {
  env: {
    PATH: process.env.PATH,
    CI: "true",
    WRANGLER_SEND_METRICS: "false",
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_CACHE_HOME: join(scratch, "cache"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(worker, "exit");
let log = "";
for (const channel of [worker.stdout, worker.stderr]) {
  channel.setEncoding("utf8");
  channel.on("data", data => { log = (log + data).slice(-32_000); });
}

function request(route, body, { method = "POST", authorized = true, timeoutMs = 30_000, signal } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  return fetch(base + route, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(authorized ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
}

async function json(route, body, options) {
  const response = await request(route, body, options);
  const payload = await response.json();
  assert.equal(response.status, options?.status ?? 200, JSON.stringify(payload));
  return payload;
}

async function ready() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null || worker.signalCode !== null) throw new Error("Wrangler quit before readiness");
    try {
      const response = await request("/health", undefined, { method: "GET", timeoutMs: 1000 });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // The listener may not exist until the local Docker build finishes.
    }
    await delay(500);
  }
  throw new Error("Timed out waiting for the local Wrangler Worker");
}

function eventFrames(text) {
  const complete = text.split("\n\n");
  complete.pop();
  return complete.flatMap(frame => {
    const [kind, data] = frame.split("\n");
    if (!kind.startsWith("event: ") || !data?.startsWith("data: ")) return [];
    return [{ type: kind.slice("event: ".length), payload: JSON.parse(data.slice("data: ".length)) }];
  });
}

async function waitForOutput(reader, marker) {
  const decoder = new TextDecoder();
  let text = "";
  while (!eventFrames(text).filter(event => event.type === "stdout").map(event => event.payload.data).join("").includes(marker)) {
    const chunk = await reader.read();
    assert.ok(!chunk.done, "the Worker ended the stream before the native command started");
    text += decoder.decode(chunk.value, { stream: true });
  }
}

let lease;
try {
  await ready();
  assert.equal((await request("/health", undefined, { method: "GET", authorized: false })).status, 401);
  const requestLease = { environmentId: "integration", runId: "integration", sleepAfter: "5m", keepAlive: true };
  lease = await json("/leases/acquire", requestLease, { timeoutMs: 90_000 });
  assert.ok(lease.providerLeaseId, "acquire returns a lease ID");
  const bound = { providerLeaseId: lease.providerLeaseId };
  const resumed = await json("/leases/resume", { ...requestLease, ...bound });
  assert.equal(resumed.metadata.resumedLease, true);

  const output = await request("/exec", {
    ...bound,
    command: "sh",
    args: ["-c", 'IFS= read -r line; printf "out:%s\n" "$line"; printf "err:%s\n" "$1" >&2', "fixture", "apostrophe's"],
    stdin: "from stdin\n",
    streamOutput: true,
  });
  assert.equal(output.status, 200);
  const events = eventFrames(await output.text());
  assert.equal(events.filter(event => event.type === "stdout").map(event => event.payload.data).join(""), "out:from stdin\n");
  assert.equal(events.filter(event => event.type === "stderr").map(event => event.payload.data).join(""), "err:apostrophe's\n");
  assert.equal(events.at(-1)?.type, "complete", JSON.stringify(events));
  assert.equal(events.at(-1).payload.exitCode, 0);

  const named = { ...bound, sessionStrategy: "named", sessionId: "environment", command: "sh", args: ["-c", 'printf %s "$SESSION_FIXTURE"'] };
  assert.equal((await json("/exec", { ...named, env: { SESSION_FIXTURE: "named" } })).stdout, "named");
  assert.equal((await json("/exec", named)).stdout, "named");
  assert.equal((await json("/exec", { ...named, sessionStrategy: "default" })).stdout, "");

  const timedOut = await json("/exec", {
    ...bound, command: "sh", args: ["-c", "(sleep 0.8; touch /tmp/proprio-late-write) & wait"], timeoutMs: 150,
  });
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.timedOut, true);
  await delay(1000);
  assert.equal((await json("/exec", { ...bound, command: "test", args: ["!", "-e", "/tmp/proprio-late-write"] })).exitCode, 0);

  const disconnect = new AbortController();
  const streaming = await request("/exec", {
    ...bound,
    command: "sh",
    args: ["-c", 'printf disconnect-ready; (sleep 2; touch /tmp/proprio-after-disconnect) & wait'],
    streamOutput: true,
  }, { signal: disconnect.signal });
  const streamReader = streaming.body.getReader();
  try {
    await waitForOutput(streamReader, "disconnect-ready");
    disconnect.abort();
  } finally {
    await streamReader.cancel().catch(() => undefined);
    streamReader.releaseLock();
  }
  await delay(2300);
  assert.equal((await json("/exec", { ...bound, command: "test", args: ["!", "-e", "/tmp/proprio-after-disconnect"] })).exitCode, 0);

  await json("/leases/release", bound);
  const missing = await json("/leases/resume", { ...requestLease, ...bound }, { status: 409 });
  assert.equal(missing.error, "sandbox_state_lost");
  lease = await json("/leases/acquire", { ...requestLease, runId: "stop" }, { timeoutMs: 90_000 });
  const stopping = await request("/exec", {
    providerLeaseId: lease.providerLeaseId,
    command: "sh", args: ["-c", "printf stop-ready; sleep 30"], streamOutput: true,
  });
  const stoppingReader = stopping.body.getReader();
  try {
    await waitForOutput(stoppingReader, "stop-ready");
    await json(`/leases/${encodeURIComponent(lease.providerLeaseId)}`, undefined, { method: "DELETE" });
    // Destroyed containers may close the underlying stream with an error.
    // An active process must finish well before its own sleep ends.
    const drained = (async () => {
      for (;;) {
        try { if ((await stoppingReader.read()).done) return true; }
        catch { return true; }
      }
    })();
    assert.equal(await Promise.race([drained, delay(5000, false, { ref: false })]), true);
  } finally {
    await stoppingReader.cancel().catch(() => undefined);
    stoppingReader.releaseLock();
  }
  const stoppedLease = await json("/leases/resume", { ...requestLease, providerLeaseId: lease.providerLeaseId }, { status: 409 });
  assert.equal(stoppedLease.error, "sandbox_state_lost");
  lease = undefined;
  console.log("Local Wrangler and Docker verified auth, acquire, resume, native stdin and SSE, session scope, process-group timeout, disconnect, Stop, release, and lost-state detection.");
} catch (error) {
  console.error(log);
  throw error;
} finally {
  if (lease) {
    await request(`/leases/${encodeURIComponent(lease.providerLeaseId)}`, undefined, { method: "DELETE", timeoutMs: 5000 }).catch(() => undefined);
  }
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), delay(5000, false, { ref: false })]);
  if (!stopped) {
    worker.kill("SIGKILL");
    await exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
