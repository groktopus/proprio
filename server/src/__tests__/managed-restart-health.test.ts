import { createHmac, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MANAGED_RESTART_LOCK_FILENAME,
  MANAGED_RESTART_PROBE_HEADER,
  MANAGED_RESTART_PROOF_HEADER,
  managedRestartProbeMessage,
} from "@groktopus/shared/service-restart-probe";
import express from "express";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { healthRoutes } from "../routes/health.js";

afterEach(() => vi.unstubAllEnvs());

it("signs the health of the requested managed process using its instance lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "managed-health-proof-"));
  try {
    vi.stubEnv("PROPRIO_HOME", home);
    vi.stubEnv("PROPRIO_INSTANCE_ID", "managed-health");
    vi.stubEnv("PROPRIO_SERVICE_MANAGED", "1");
    const instance = path.join(home, "instances", "managed-health");
    const token = randomUUID();
    await mkdir(instance, { recursive: true });
    await writeFile(path.join(instance, MANAGED_RESTART_LOCK_FILENAME), token + "\n", { mode: 0o600 });
    const app = express();
    app.use("/api/health", healthRoutes());
    const challenge = `${process.pid}:${randomUUID()}`;

    const ownResponse = await request(app).get("/api/health").set(MANAGED_RESTART_PROBE_HEADER, challenge);
    const { status, serverVersion, commit } = ownResponse.body;
    const message = managedRestartProbeMessage(challenge, status === "ok", serverVersion, commit);
    expect(ownResponse.headers[MANAGED_RESTART_PROOF_HEADER]).toBe(createHmac("sha256", token).update(message).digest("hex"));
    expect(ownResponse.headers["cache-control"]).toBe("no-store");

    const otherResponse = await request(app).get("/api/health").set(MANAGED_RESTART_PROBE_HEADER, `${process.pid + 1}:${randomUUID()}`);
    expect(otherResponse.headers[MANAGED_RESTART_PROOF_HEADER]).toBeUndefined();
    const ordinaryResponse = await request(app).get("/api/health");
    expect(ordinaryResponse.headers[MANAGED_RESTART_PROOF_HEADER]).toBeUndefined();
    vi.stubEnv("PROPRIO_SERVICE_MANAGED", undefined);
    const unmanagedResponse = await request(app).get("/api/health").set(MANAGED_RESTART_PROBE_HEADER, challenge);
    expect(unmanagedResponse.headers[MANAGED_RESTART_PROOF_HEADER]).toBeUndefined();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("limits managed restart probes while keeping ordinary health available", async () => {
  const app = express();
  app.use("/api/health", healthRoutes());
  const client = request(app);
  const probe = `${process.pid}:${randomUUID()}`;
  for (let requestNumber = 0; requestNumber < 180; requestNumber++) {
    const response = await client.get("/api/health").set(MANAGED_RESTART_PROBE_HEADER, probe);
    expect(response.status).not.toBe(429);
  }
  await client.get("/api/health").set(MANAGED_RESTART_PROBE_HEADER, probe).expect(429);
  await client.get("/api/health").set("x-proprio-dev-server-status-token", "fixture").expect(429);
  expect((await client.get("/api/health")).status).not.toBe(429);
});
