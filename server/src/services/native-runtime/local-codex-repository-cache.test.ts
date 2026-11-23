import { mkdtemp, mkdir, writeFile, link, lstat, readdir, utimes, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureNativeHarnessArchive, restoreNativeHarnessArchive } from "./native-harness-backup-archive.js";
import { localCodexRepositoryCache } from "./local-codex-repository-cache.js";
import { RUNTIME_ASSET_RETENTION_MS } from "./runtime-asset-retention.js";

let root: string;
let state: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "proprio-local-codex-cache-"));
  state = join(root, "state");
  await mkdir(state);
  vi.stubEnv("PROPRIO_HOME", join(root, "controller-home"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it.skipIf(process.platform === "win32")("serializes one company and pin without sharing paths across companies", async () => {
  const pin = "a".repeat(64);
  const otherCompany = await localCodexRepositoryCache(state, "company-two").use(pin, async path => path);
  const { use } = localCodexRepositoryCache(state, "company-one");
  let firstPath = "";
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const finishPublication = new Promise<void>(resolve => { finish = resolve; });
  const first = use(pin, async path => {
    firstPath = path;
    entered();
    await finishPublication;
    await mkdir(path);
    await writeFile(join(path, "current"), "pinned");
  });
  await Promise.race([ready, first]);
  const second = use(pin, async path => {
    expect(await readFile(join(path, "current"), "utf8")).toBe("pinned");
  });
  finish();
  await Promise.all([first, second]);
  expect(firstPath).not.toBe(otherCompany);
  await expect(localCodexRepositoryCache(state, "company-one").use("../outside", async path => path)).rejects.toThrow("Invalid pinned repository digest");
});

it.skipIf(process.platform === "win32")("prunes expired unreferenced trees and unpublished cache entries", async () => {
  const pin = "a".repeat(64);
  const stalePin = "b".repeat(64);
  const livePin = "c".repeat(64);
  const stagedPin = "d".repeat(64);
  const retiredPin = "e".repeat(64);
  const liveFile = join(root, "live-session-skill");
  let stale = "";
  let staging = "";
  let retired = "";
  let live = "";
  const expired = new Date(Date.now() - RUNTIME_ASSET_RETENTION_MS - 3_600_000);

  await localCodexRepositoryCache(state, "company-one").use(pin, async repository => {
    const company = dirname(repository);
    stale = join(company, stalePin);
    staging = join(company, `.repository-staging-${stagedPin}-dryRun`);
    retired = join(company, `.repository-retired-${retiredPin}-interrupted`);
    live = join(company, livePin);
    for (const candidate of [stale, staging, retired, live]) {
      await mkdir(candidate);
      await writeFile(join(candidate, "file"), "pinned", { mode: 0o444 });
      await utimes(candidate, expired, expired);
    }
    await link(join(live, "file"), liveFile);
  });
  await vi.waitFor(async () => {
    await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(retired)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(dirname(stale))).toEqual([livePin]);
  });
  expect(await readFile(liveFile, "utf8")).toBe("pinned");
  expect((await lstat(join(live, "file"))).mode & 0o777).toBe(0o444);
});

it.skipIf(process.platform === "win32")("restores an archived skill after the shared cache has been removed", async () => {
  const home = join(root, "home");
  const cache = join(root, "cache");
  const pinned = join(cache, "pinned");
  const skill = join(home, "skills", "assigned", ".proprio-repository");
  await mkdir(skill, { recursive: true });
  await mkdir(cache);
  await writeFile(join(home, "manifest.json"), "{}");
  await writeFile(pinned, "pinned repository bytes", { mode: 0o444 });
  await link(pinned, join(skill, "shared.txt"));

  const archive = join(root, "checkpoint.tar");
  await captureNativeHarnessArchive(home, archive);
  await rm(cache, { recursive: true });
  const retained = join(skill, "shared.txt");
  expect(await readFile(retained, "utf8")).toBe("pinned repository bytes");
  expect((await lstat(retained)).mode & 0o777).toBe(0o444);
  const restored = join(root, "restored");
  await restoreNativeHarnessArchive(archive, restored);
  const restoredFile = join(restored, "skills", "assigned", ".proprio-repository", "shared.txt");
  expect(await readFile(restoredFile, "utf8")).toBe("pinned repository bytes");
  const info = await lstat(restoredFile);
  expect(info.nlink).toBe(1);
  expect(info.mode & 0o777).toBe(0o444);
});
