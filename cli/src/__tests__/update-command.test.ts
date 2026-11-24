import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeManagedShim, flipCurrentAtomic, initializeInstallStore, payloadPathFor, readInstallManifest, resolveInstallStorePaths, withInstallStoreLock, writeInstallManifestAtomic, type InstallManifest, type InstallRecord } from "../install-store.js";
import type { CommandRunner } from "../commands/install.js";
import { compareVersions, detectInstallMode, resolveUpdateRequest, rollbackManagedInstall, updateCommand } from "../commands/update.js";

let root: string;
let previousHome: string | undefined;
let previousProprioHome: string | undefined;

function record(payloadPath: string, version: string, channel: "latest" | "canary" | "pinned" = "latest"): InstallRecord {
  return { source: "npm", version, channel, payloadPath, installedAt: `2026-07-22T00:00:0${version}.000Z` };
}
function createPayload(payloadPath: string, version: string): string {
  const entrypoint = path.join(payloadPath, "node_modules", "proprio", "dist", "index.js");
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, version);
  return entrypoint;
}
function gitUpdateFixture(targetCached = true) {
  const paths = resolveInstallStorePaths();
  initializeInstallStore(paths);
  const currentSha = "1".repeat(40);
  const targetSha = "2".repeat(40);
  const currentPayload = payloadPathFor(paths, "git", currentSha.slice(0, 12));
  const targetPayload = payloadPathFor(paths, "git", targetSha.slice(0, 12));
  const executablePath = createPayload(currentPayload, "1.0.0");
  if (targetCached) {
    createPayload(targetPayload, "2.0.0");
    fs.writeFileSync(path.join(targetPayload, "node_modules/proprio/package.json"), JSON.stringify({ version: "2.0.0" }));
  }
  flipCurrentAtomic(currentPayload, paths);
  writeInstallManifestAtomic({
    schemaVersion: 1, source: "git", channel: "pinned", version: "1.0.0",
    repo: "groktopus/proprio", ref: "main", sha: currentSha, payloadPath: currentPayload,
    installedAt: "2026-07-22T00:00:00.000Z", previous: [],
  }, paths);
  writeManagedShim(paths);

  const runCommand = vi.fn<CommandRunner>(async (file, args) => {
    if (file === "curl" && args.at(-1) === "https://api.github.com/repos/groktopus/proprio/commits/main") {
      return { stdout: JSON.stringify({ sha: targetSha }), stderr: "" };
    }
    if (file === process.execPath && args.at(-1) === "--version") {
      return { stdout: "2.0.0\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
  return { paths, executablePath, currentSha, targetSha, currentPayload, targetPayload, runCommand };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "proprio-update-"));
  previousHome = process.env.HOME;
  previousProprioHome = process.env.PROPRIO_HOME;
  process.env.HOME = path.join(root, "home");
  process.env.PROPRIO_HOME = path.join(root, "proprio");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProprioHome === undefined) delete process.env.PROPRIO_HOME; else process.env.PROPRIO_HOME = previousProprioHome;
  fs.rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("update command", () => {
  it.each(["npm", "git", "global-npm"] as const)("rejects %s updates on unsupported Node before any update work", async (source) => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const payload = payloadPathFor(paths, "npm", "1.0.0");
    const entrypoint = createPayload(payload, "1.0.0");
    flipCurrentAtomic(payload, paths);
    const manifest: InstallManifest = { schemaVersion: 1, ...record(payload, "1.0.0"), source: source === "git" ? "git" : "npm", previous: [] };
    writeInstallManifestAtomic(manifest, paths);
    const runCommand = vi.fn<CommandRunner>();
    const backup = vi.fn();
    const restartActiveService = vi.fn();
    const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { ...nodeVersion, value: "22.22.2" });
    try {
      await expect(updateCommand({ yes: true }, {
        paths,
        executablePath: source === "global-npm" ? path.join(root, "lib", "node_modules", "proprio", "dist", "index.js") : entrypoint,
        runCommand, backup, restartActiveService,
      })).rejects.toThrow("pnpm proprio install --yes");
      expect(runCommand).not.toHaveBeenCalled();
      expect(backup).not.toHaveBeenCalled();
      expect(restartActiveService).not.toHaveBeenCalled();
      expect(readInstallManifest(paths)).toEqual(manifest);
      expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(payload));
    } finally {
      Object.defineProperty(process.versions, "node", nodeVersion);
    }
  });

  it("keeps update checks, dry runs, and rollback available on unsupported Node", async () => {
    const fixture = gitUpdateFixture();
    const { paths, currentPayload, currentSha, targetSha, runCommand } = fixture;
    const restartActiveService = vi.fn(async () => false);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node")!;
    Object.defineProperty(process.versions, "node", { ...nodeVersion, value: "22.22.2" });
    try {
      await updateCommand({ check: true, json: true }, fixture);
      expect(process.exitCode).toBe(10);
      await updateCommand({ dryRun: true, json: true }, fixture);
      expect(JSON.parse(String(log.mock.lastCall?.[0]))).toMatchObject({ currentSha, targetSha, changed: true, dryRun: true });
      expect(runCommand).toHaveBeenCalledTimes(2);
      expect(readInstallManifest(paths)?.sha).toBe(currentSha);
      expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(currentPayload));

      const { previous: _previous, schemaVersion, ...original } = readInstallManifest(paths)!;
      const targetPayload = fixture.targetPayload;
      flipCurrentAtomic(targetPayload, paths);
      writeInstallManifestAtomic({
        schemaVersion, ...original, sha: targetSha, version: "2.0.0", payloadPath: targetPayload,
        previous: [original],
      }, paths);
      await updateCommand({ rollback: true }, {
        ...fixture, executablePath: path.join(targetPayload, "node_modules/proprio/dist/index.js"), restartActiveService,
      });
      expect(readInstallManifest(paths)?.sha).toBe(currentSha);
      expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(currentPayload));
      expect(restartActiveService).toHaveBeenCalledWith("1.0.0", { expectedCommit: currentSha });
    } finally {
      Object.defineProperty(process.versions, "node", nodeVersion);
    }
  });

  it("orders SemVer prerelease identifiers numerically", () => {
    expect(compareVersions("1.0.0-canary.10", "1.0.0-canary.2")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });

  it("detects managed, global npm, npx, and source modes", () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const payload = payloadPathFor(paths, "npm", "1.0.0"); const entrypoint = createPayload(payload, "1.0.0");
    flipCurrentAtomic(payload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, ...record(payload, "1.0.0"), previous: [] }, paths);
    expect(detectInstallMode(entrypoint, paths)).toBe("managed");
    expect(detectInstallMode(path.join(root, "lib", "node_modules", "proprio", "dist", "index.js"), paths)).toBe("global-npm");
    expect(detectInstallMode(path.join(root, ".npm", "_npx", "abc", "node_modules", "proprio", "dist", "index.js"), paths)).toBe("npx");
    const source = path.join(root, "source"); fs.mkdirSync(path.join(source, ".git"), { recursive: true });
    expect(detectInstallMode(path.join(source, "cli", "src", "index.ts"), paths)).toBe("source");
  });

  it("resolves channels and keeps pinned installs pinned by default", () => {
    const manifest = { channel: "pinned", version: "1.2.3" } as InstallManifest;
    expect(resolveUpdateRequest(manifest, {})).toEqual({ spec: "1.2.3", channel: "pinned", explicit: false });
    expect(resolveUpdateRequest(manifest, { latest: true })).toEqual({ spec: "latest", channel: "latest", explicit: true });
    expect(() => resolveUpdateRequest(manifest, { latest: true, canary: true })).toThrow("only one");
  });

  it.each([true, false])("validates a same-version Git update before retaining its new payload (%s)", async (replacementHealthy) => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const oldSha = "1".repeat(40); const newSha = "2".repeat(40);
    const oldPayload = payloadPathFor(paths, "git", oldSha.slice(0, 12));
    const executable = createPayload(oldPayload, "0.3.1");
    fs.writeFileSync(path.join(oldPayload, "node_modules", "proprio", "package.json"), JSON.stringify({ version: "0.3.1" }));
    const newPayload = payloadPathFor(paths, "git", newSha.slice(0, 12));
    createPayload(newPayload, "0.3.1");
    fs.writeFileSync(path.join(newPayload, "node_modules", "proprio", "package.json"), JSON.stringify({ version: "0.3.1" }));
    flipCurrentAtomic(oldPayload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, source: "git", version: "0.3.1", channel: "pinned", repo: "groktopus/proprio", ref: "master", sha: oldSha, payloadPath: oldPayload, installedAt: "2026-07-22T00:00:00.000Z", previous: [] }, paths);
    writeManagedShim(paths);
    // Simulate a launcher generated before child-runtime PATH pinning existed.
    fs.writeFileSync(paths.shimPath, fs.readFileSync(paths.shimPath, "utf8").replace(/^export PATH=.*\n/m, ""));
    const backup = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => true);
    const restartActiveService = vi.fn(async (_version: string, target?: { expectedCommit?: string }) => {
      if (!replacementHealthy && target?.expectedCommit === newSha) throw new Error("health reported the previous commit");
      return true;
    });
    const runCommand = vi.fn(async (file: string) => file === "curl" ? { stdout: JSON.stringify({ sha: newSha }), stderr: "" } : { stdout: "0.3.1\n", stderr: "" });
    const update = updateCommand({}, { paths, executablePath: executable, runCommand, backup, confirm, restartActiveService, hasInstanceData: () => true, now: () => new Date("2026-07-22T12:00:00Z") });
    if (replacementHealthy) await update;
    else await expect(update).rejects.toThrow("Updated git payload failed service validation and was rolled back");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(`commit ${newSha.slice(0, 12)}`));
    expect(fs.readFileSync(paths.shimPath, "utf8")).toContain(`export PATH='${path.dirname(process.execPath)}'`);
    expect(backup).toHaveBeenCalledOnce();
    expect(restartActiveService).toHaveBeenNthCalledWith(1, "0.3.1", { expectedCommit: newSha });
    if (!replacementHealthy) {
      expect(restartActiveService).toHaveBeenNthCalledWith(2, "0.3.1", {
        expectedCommit: oldSha, startIfInactive: true,
      });
    }
    expect(readInstallManifest(paths)?.sha).toBe(replacementHealthy ? newSha : oldSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(replacementHealthy ? newPayload : oldPayload));
  });

  it.each(["older passes", "older fails", "both fail", "staging fails"] as const)("settles overlapping managed Git updates when %s", async mode => {
    const olderHealthy = mode === "older passes";
    const paths = resolveInstallStorePaths();
    initializeInstallStore(paths);
    const originalSha = "1".repeat(40);
    const olderSha = "2".repeat(40);
    const newerSha = "3".repeat(40);
    const seedPayload = (sha: string) => {
      const payload = payloadPathFor(paths, "git", sha.slice(0, 12));
      createPayload(payload, "0.3.1");
      fs.writeFileSync(path.join(payload, "node_modules/proprio/package.json"), JSON.stringify({ version: "0.3.1" }));
      return payload;
    };
    const originalPayload = seedPayload(originalSha);
    const olderPayload = seedPayload(olderSha);
    flipCurrentAtomic(originalPayload, paths);
    writeInstallManifestAtomic({
      schemaVersion: 1, source: "git", version: "0.3.1", channel: "pinned",
      repo: "groktopus/proprio", ref: "main", sha: originalSha,
      payloadPath: originalPayload, installedAt: "2026-07-22T00:00:00.000Z", previous: [],
    }, paths);
    writeManagedShim(paths);

    const validationStarted = Promise.withResolvers<void>();
    const releaseValidation = Promise.withResolvers<void>();
    const validationError = new Error("older commit failed validation");
    const olderRestart = vi.fn(async (_version: string, target?: { expectedCommit?: string }) => {
      if (target?.expectedCommit === olderSha) {
        validationStarted.resolve();
        await releaseValidation.promise;
        if (!olderHealthy) throw validationError;
      }
      return true;
    });
    const runCommand = (sha: string) => vi.fn(async (file: string) => file === "curl"
      ? { stdout: JSON.stringify({ sha }), stderr: "" }
      : { stdout: "0.3.1\n", stderr: "" });
    const executable = (payload: string) => path.join(payload, "node_modules/proprio/dist/index.js");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const olderUpdate = updateCommand({ yes: true, backup: false, json: true }, {
      paths, executablePath: executable(originalPayload), runCommand: runCommand(olderSha),
      restartActiveService: olderRestart,
    }).then(() => undefined, (error: unknown) => error);

    const newerRestart = vi.fn(async (_version: string, target?: { expectedCommit?: string }) => {
      if (mode === "both fail" && target?.expectedCommit === newerSha) throw new Error("newer commit failed validation");
      return true;
    });
    try {
      await Promise.race([validationStarted.promise, olderUpdate.then(error => { throw error; })]);
      expect(readInstallManifest(paths)?.sha).toBe(olderSha);
      if (mode === "staging fails") {
        const buildError = new Error("staging failed before activation");
        const staging = withInstallStoreLock(async () => {
          releaseValidation.resolve();
          // Keep the lock after the older validation rejects. A failed build
          // leaves the older activation in place for its rollback to settle.
          await new Promise(resolve => setTimeout(resolve, 50));
          throw buildError;
        }, paths);
        await expect(staging).rejects.toBe(buildError);
      } else {
        seedPayload(newerSha);
        const newerUpdate = updateCommand({ yes: true, backup: false, json: true }, {
          paths, executablePath: executable(olderPayload), runCommand: runCommand(newerSha),
          restartActiveService: newerRestart,
        });
        if (mode === "both fail") await expect(newerUpdate).rejects.toThrow("rolled back to 0.3.1");
        else {
          await newerUpdate;
          expect(readInstallManifest(paths)?.sha).toBe(newerSha);
        }
      }
    } finally {
      releaseValidation.resolve();
      await olderUpdate;
    }

    const shouldRestoreOriginal = mode === "both fail" || mode === "staging fails";
    const activeSha = shouldRestoreOriginal ? originalSha : newerSha;
    expect(readInstallManifest(paths)?.sha).toBe(activeSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(payloadPathFor(paths, "git", activeSha.slice(0, 12))));
    if (mode === "staging fails") {
      expect(olderRestart).toHaveBeenLastCalledWith("0.3.1", { expectedCommit: originalSha, startIfInactive: true });
      expect(await olderUpdate).toMatchObject({ message: expect.stringContaining("rolled back"), cause: validationError });
      expect(stdout).not.toHaveBeenCalled();
      return;
    }
    expect(olderRestart).toHaveBeenCalledExactlyOnceWith("0.3.1", { expectedCommit: olderSha });
    expect(await olderUpdate).toMatchObject({
      message: expect.stringContaining("superseded"),
      ...(olderHealthy ? {} : { cause: validationError }),
    });
    if (mode === "both fail") {
      expect(newerRestart).toHaveBeenLastCalledWith("0.3.1", { expectedCommit: originalSha, startIfInactive: true });
      expect(stdout).not.toHaveBeenCalled();
    } else {
      expect(stdout).toHaveBeenCalledOnce();
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ targetSha: newerSha, restarted: true });
    }
  });

  it("reports SHA git installs as pinned without resolving again", async () => {
    const paths = resolveInstallStorePaths(); initializeInstallStore(paths);
    const sha = "3".repeat(40); const payload = payloadPathFor(paths, "git", sha.slice(0, 12)); const executable = createPayload(payload, "0.3.1");
    flipCurrentAtomic(payload, paths);
    writeInstallManifestAtomic({ schemaVersion: 1, source: "git", version: "0.3.1", channel: "pinned", repo: "groktopus/proprio", ref: sha.slice(0, 12), sha, payloadPath: payload, installedAt: "2026-07-22T00:00:00.000Z", previous: [] }, paths);
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await updateCommand({}, { paths, executablePath: executable, runCommand });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(["managed", "global-npm"] as const)("rejects %s registry updates before running npm", async (mode) => {
    const paths = resolveInstallStorePaths();
    const payload = payloadPathFor(paths, "npm", "1.0.0");
    const managedEntrypoint = createPayload(payload, "1.0.0");
    initializeInstallStore(paths);
    flipCurrentAtomic(payload, paths);
    const manifest = { schemaVersion: 1 as const, ...record(payload, "1.0.0", "pinned"), previous: [] };
    writeInstallManifestAtomic(manifest, paths);
    const executablePath = mode === "managed"
      ? managedEntrypoint
      : path.join(root, "lib/node_modules/proprio/dist/index.js");
    const runCommand = vi.fn<CommandRunner>();
    const backup = vi.fn();

    await expect(updateCommand({}, { paths, executablePath, runCommand, backup }))
      .rejects.toThrow("registry installation and updates are disabled");
    expect(runCommand).not.toHaveBeenCalled();
    expect(backup).not.toHaveBeenCalled();
    expect(readInstallManifest(paths)).toEqual(manifest);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(payload));
  });

  it("requires explicit confirmation before updating a Git payload", async () => {
    const fixture = gitUpdateFixture(false);
    const { paths, currentSha, targetSha, targetPayload } = fixture;
    const confirm = vi.fn(async () => false);
    const backup = vi.fn();
    await expect(updateCommand({}, { ...fixture, confirm, backup })).rejects.toThrow("Git update cancelled");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining(targetSha.slice(0, 12)));
    expect(backup).not.toHaveBeenCalled();
    expect(fs.existsSync(targetPayload)).toBe(false);
    expect(readInstallManifest(paths)?.sha).toBe(currentSha);
  });

  it("backs up before activation, retains both Git payloads, and permits rollback", async () => {
    const fixture = gitUpdateFixture();
    const { paths, currentSha, targetSha, currentPayload, targetPayload, runCommand } = fixture;
    const backup = vi.fn(async () => {
      expect(readInstallManifest(paths)?.sha).toBe(currentSha);
      expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(currentPayload));
      expect(runCommand).toHaveBeenCalledTimes(1);
    });
    const restartActiveService = vi.fn(async () => {
      expect(readInstallManifest(paths)?.sha).toBe(targetSha);
      return true;
    });
    await updateCommand({ yes: true }, { ...fixture, backup, restartActiveService, hasInstanceData: () => true });
    expect(backup).toHaveBeenCalledOnce();
    expect(restartActiveService).toHaveBeenCalledWith("2.0.0", { expectedCommit: targetSha });
    expect(readInstallManifest(paths)?.sha).toBe(targetSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(targetPayload));
    expect(rollbackManagedInstall(paths).sha).toBe(currentSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(currentPayload));
    expect(fs.existsSync(targetPayload)).toBe(true);
  });

  it("explains how to recover when the pre-update database is unreachable", async () => {
    const fixture = gitUpdateFixture(false);
    const { paths, currentSha, currentPayload, targetPayload, runCommand } = fixture;
    const backupError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:54329"), { code: "ECONNREFUSED" });
    const backup = vi.fn(async () => { throw backupError; });

    await expect(updateCommand({ yes: true }, { ...fixture, backup, hasInstanceData: () => true })).rejects.toThrow(
      "Start the service with `proprio service start` and retry, or skip the backup with `proprio update --no-backup`.",
    );
    expect(backup).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(targetPayload)).toBe(false);
    expect(readInstallManifest(paths)?.sha).toBe(currentSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(currentPayload));
  });

  it("skips the pre-update backup when there is no onboarded instance data", async () => {
    const fixture = gitUpdateFixture();
    const backup = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await updateCommand({ yes: true }, {
      ...fixture, backup, restartActiveService: async () => false, hasInstanceData: () => false,
    });

    expect(backup).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("has not been onboarded and has no data to back up"));
    expect(readInstallManifest(fixture.paths)?.sha).toBe(fixture.targetSha);
  });

  it("surfaces a failure to restart the rolled-back Git payload", async () => {
    const fixture = gitUpdateFixture();
    const { paths, currentSha, targetSha, currentPayload } = fixture;
    const restartActiveService = vi.fn(async (version: string) => {
      throw new Error(version === "2.0.0" ? "health timeout" : "rollback restart failed");
    });

    await expect(updateCommand({ yes: true, backup: false }, {
      ...fixture, restartActiveService,
    })).rejects.toThrow("rolled-back service also failed to restart");
    expect(readInstallManifest(paths)?.sha).toBe(currentSha);
    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(currentPayload));
    expect(restartActiveService).toHaveBeenNthCalledWith(1, "2.0.0", { expectedCommit: targetSha });
    expect(restartActiveService).toHaveBeenNthCalledWith(2, "1.0.0", { expectedCommit: currentSha, startIfInactive: true });
  });
});
