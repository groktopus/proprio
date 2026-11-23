import { createHmac } from "node:crypto";
import {
  MANAGED_RESTART_PROBE_HEADER,
  MANAGED_RESTART_PROOF_HEADER,
  managedRestartProbeMessage,
} from "@groktopus/shared/service-restart-probe";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restartManagedService } from "../commands/service.js";
import * as managers from "../services/service-manager.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "managed-service-restart-"));
  vi.stubEnv("PROPRIO_HOME", home);
  vi.stubEnv("PROPRIO_INSTANCE_ID", "fixture");
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const status = (pid: number | null): managers.ServiceStatus => ({
  platform: "systemd", serviceName: "proprio-fixture.service",
  installed: true, active: pid !== null, enabled: true, pid,
});

function supervisor(replacementPid: number | null, afterRestart?: () => Promise<void>, previousPid: number | null = 42) {
  let replaced = false;
  const manager = {
    status: vi.fn(async () => status(replaced ? replacementPid : previousPid)),
    start: vi.fn(async () => { replaced = true; }),
    restart: vi.fn(async () => { replaced = true; await afterRestart?.(); }),
  };
  vi.spyOn(managers, "detectServiceManager").mockResolvedValue({
    supported: true, manager: manager as unknown as managers.ServiceManager,
  });
  return manager;
}

function signedHealth(commit: string) {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, options?: RequestInit) => {
    const challenge = new Headers(options?.headers).get(MANAGED_RESTART_PROBE_HEADER);
    const body = { status: "ok", serverVersion: "0.3.1", commit };
    if (!challenge) return Response.json(body);
    const token = (await readFile(path.join(home, "instances", "fixture", "hot-restart.lock"), "utf8")).trim();
    const proof = createHmac("sha256", token).update(managedRestartProbeMessage(challenge, true, body.serverVersion, commit)).digest("hex");
    return Response.json(body, { headers: { [MANAGED_RESTART_PROOF_HEADER]: proof } });
  }));
}

describe("managed service restart", () => {
  it.each([null, 42, 43])("rejects version-only health when the supervisor reports PID %s", async replacementPid => {
    const manager = supervisor(replacementPid);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "ok", serverVersion: "0.3.1" })));
    const result = restartManagedService({ instanceId: "fixture", expectedVersion: "0.3.1" });
    const validation = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(manager.restart).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(65_000);
    await validation;
  });

  it("requires the new Git commit even when the replacement reports the same version", async () => {
    const manager = supervisor(43);
    signedHealth("1".repeat(40));
    const result = restartManagedService({ expectedVersion: "0.3.1", expectedCommit: "2".repeat(40) });
    const validation = expect(result).rejects.toThrow(/reported version 0\.3\.1 and commit 11/);
    await vi.waitFor(() => expect(manager.restart).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(65_000);
    await validation;
  });

  it("verifies the managed replacement and returns its matching drain report", async () => {
    const instance = path.join(home, "instances", "fixture");
    const target = "2".repeat(40);
    const manager = supervisor(43, async () => {
      const intent = JSON.parse(await readFile(path.join(instance, "hot-restart-intent.json"), "utf8"));
      expect(intent).toMatchObject({ previousServerPid: 42, drainRequired: true });
      await writeFile(path.join(instance, "hot-restart-report.json"), JSON.stringify({
        requestedAt: intent.requestedAt, previousServerPid: 42, newServerPid: 43, drainRequired: true,
      }));
    });
    signedHealth(target);

    await expect(restartManagedService({ expectedVersion: "0.3.1", expectedCommit: target, waitForDrain: true })).resolves.toMatchObject({
      status: { active: true, pid: 43 }, health: { ok: true, commit: target },
      report: { previousServerPid: 42, newServerPid: 43, drainRequired: true },
    });
    expect(manager.restart).toHaveBeenCalledOnce();
  });

  it("starts the rollback payload when the failed replacement is inactive", async () => {
    const manager = supervisor(43, undefined, null);
    signedHealth("1".repeat(40));
    await expect(restartManagedService({ startIfInactive: true, expectedVersion: "0.3.1" })).resolves.toMatchObject({
      status: { active: true, pid: 43 }, report: null,
    });
    expect(manager.start).toHaveBeenCalledOnce();
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it("returns no report when the proven replacement has no correlated report", async () => {
    const manager = supervisor(43);
    signedHealth("2".repeat(40));
    const result = restartManagedService({ expectedVersion: "0.3.1" });
    const validation = expect(result).resolves.toMatchObject({ status: { active: true, pid: 43 }, report: null });
    await vi.waitFor(() => expect(manager.restart).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(12_000);
    await validation;
  });
});
