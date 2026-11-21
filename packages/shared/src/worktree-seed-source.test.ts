import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCanonicalWorktreeSeedSource } from "./worktree-seed-source.js";

const cleanup: string[] = [];

function makeInstance(prefix: string, instanceId: string) {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  cleanup.push(cwd);
  const configDir = path.join(cwd, ".proprio");
  const configPath = path.join(configDir, "config.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  fs.writeFileSync(path.join(configDir, ".env"), `PROPRIO_INSTANCE_ID=${instanceId}\n`);
  return { cwd, configPath, instanceId };
}

/**
 * A control plane's own instance root: `<home>/instances/<id>/config.json`, which
 * names its instance by directory and has no adjacent .env.
 */
function makeInstanceRoot(instanceId: string) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "proprio-seed-home-"));
  cleanup.push(home);
  const configDir = path.join(home, "instances", instanceId);
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, "{}\n");
  return { configPath, instanceId };
}

/** A managed project checkout: a plain clone with no `.proprio` of its own. */
function makePlainCheckout() {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "proprio-seed-checkout-"));
  cleanup.push(cwd);
  return cwd;
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveCanonicalWorktreeSeedSource", () => {
  it("returns only the registered base workspace config", () => {
    const source = makeInstance("proprio-seed-source-", "source-instance");
    const target = makeInstance("proprio-seed-target-", "target-instance");

    expect(resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: source.cwd,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toMatchObject({
      baseWorkspaceCwd: source.cwd,
      configPath: source.configPath,
      targetConfigPath: target.configPath,
    });
  });

  it("takes the named source when the base workspace carries no config of its own", () => {
    const baseCwd = makePlainCheckout();
    const source = makeInstanceRoot("default");
    const target = makeInstance("proprio-seed-target-", "target-instance");

    expect(resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: baseCwd,
      explicitSourceConfigPath: source.configPath,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toMatchObject({
      baseWorkspaceCwd: baseCwd,
      configPath: source.configPath,
      instanceId: "default",
    });
  });

  it("rejects a dangling config symlink instead of falling back to the named source", () => {
    const baseCwd = makePlainCheckout();
    fs.mkdirSync(path.join(baseCwd, ".proprio"), { recursive: true });
    fs.symlinkSync(path.join(baseCwd, "absent.json"), path.join(baseCwd, ".proprio", "config.json"));
    const source = makeInstanceRoot("default");
    const target = makeInstance("proprio-seed-dangling-target-", "target-instance");

    expect(() => resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: baseCwd,
      explicitSourceConfigPath: source.configPath,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/Registered source Proprio config does not exist/);
  });

  it("fails closed when the declared config cannot be inspected", () => {
    const baseCwd = makePlainCheckout();
    // `.proprio` as a regular file makes lstat report ENOTDIR, not ENOENT.
    fs.writeFileSync(path.join(baseCwd, ".proprio"), "not a directory\n");
    const source = makeInstanceRoot("default");
    const target = makeInstance("proprio-seed-unreadable-target-", "target-instance");

    expect(() => resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: baseCwd,
      explicitSourceConfigPath: source.configPath,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/cannot be inspected \(ENOTDIR\)/);
  });

  it("rejects a dangling .proprio symlink instead of falling back to the named source", () => {
    const baseCwd = makePlainCheckout();
    // Resolving `.proprio` fails before the probe reaches config.json, so the config
    // entry reports ENOENT even though this workspace is malformed rather than plain.
    fs.symlinkSync(path.join(baseCwd, "absent-dir"), path.join(baseCwd, ".proprio"));
    const source = makeInstanceRoot("default");
    const target = makeInstance("proprio-seed-dangling-parent-target-", "target-instance");

    expect(() => resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: baseCwd,
      explicitSourceConfigPath: source.configPath,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/cannot be inspected \(ENOENT on its \.proprio symlink target\)/);
  });

  it("takes the named source when .proprio is a symlink to a directory with no config", () => {
    const baseCwd = makePlainCheckout();
    const linked = path.join(baseCwd, "linked-config-dir");
    fs.mkdirSync(linked, { recursive: true });
    fs.symlinkSync(linked, path.join(baseCwd, ".proprio"));
    const source = makeInstanceRoot("default");
    const target = makeInstance("proprio-seed-linked-empty-target-", "target-instance");

    const resolved = resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: baseCwd,
      explicitSourceConfigPath: source.configPath,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: source.configPath, instanceId: source.instanceId },
      manifestTargetInstanceId: target.instanceId,
    });

    expect(resolved.configPath).toBe(source.configPath);
    expect(resolved.instanceId).toBe("default");
  });

  it("fails closed when the base workspace carries no config and none is named", () => {
    const baseCwd = makePlainCheckout();
    const target = makeInstance("proprio-seed-unnamed-target-", "target-instance");

    expect(() => resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: baseCwd,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: { configPath: target.configPath, instanceId: target.instanceId },
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/no Proprio config of its own/);
  });

  it("fails closed without registration and when source equals target", () => {
    const target = makeInstance("proprio-seed-same-target-", "target-instance");
    const diagnostic = { configPath: target.configPath, instanceId: target.instanceId };

    expect(() => resolveCanonicalWorktreeSeedSource({
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: diagnostic,
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/not registered/);

    expect(() => resolveCanonicalWorktreeSeedSource({
      registeredBaseWorkspaceCwd: target.cwd,
      targetConfigPath: target.configPath,
      expectedTargetInstanceId: target.instanceId,
      manifestSource: diagnostic,
      manifestTargetInstanceId: target.instanceId,
    })).toThrow(/same canonical file/);
  });
});
