import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import {
  createHermesGatewayServerAdapter,
  createHermesLocalServerAdapter,
  createServerAdapter,
  hermesGatewayType,
} from "./index.js";
import { createServerAdapter as createGatewayServerAdapterFromSubpath } from "./gateway/index.js";

test("root package export exposes Proprio external adapter entrypoint", () => {
  const adapter = createServerAdapter();

  expect(adapter.type).toBe("hermes_local");
  expect(typeof adapter.execute).toBe("function");
  expect(typeof adapter.testEnvironment).toBe("function");
  expect(typeof adapter.sessionCodec?.deserialize).toBe("function");
  expect(adapter.sessionManagement?.nativeContextManagement).toBe("confirmed");
  expect(adapter.supportsLocalAgentJwt).toBe(true);
  expect(adapter.supportsInstructionsBundle).toBe(true);
  expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
  expect(adapter.getRuntimeCommandSpec?.({ command: "hermes-dev" })).toMatchObject({
    command: "hermes-dev",
    detectCommand: "hermes-dev",
    installCommand: null,
  });
  expect(typeof adapter.detectModel).toBe("function");
  expect(typeof adapter.getConfigSchema).toBe("function");
});

test("root package export keeps explicit local and gateway adapter factories", () => {
  const localAdapter = createHermesLocalServerAdapter();
  const gatewayAdapter = createHermesGatewayServerAdapter();

  expect(localAdapter.type).toBe("hermes_local");
  expect(gatewayAdapter.type).toBe("hermes_gateway");
  expect(hermesGatewayType).toBe("hermes_gateway");
  expect(gatewayAdapter.supportsLocalAgentJwt).toBe(false);
  expect(gatewayAdapter.supportsInstructionsBundle).toBe(false);
});

test("gateway subpath export exposes the Hermes Gateway adapter entrypoint", () => {
  const adapter = createGatewayServerAdapterFromSubpath();

  expect(adapter.type).toBe("hermes_gateway");
  expect(typeof adapter.execute).toBe("function");
  expect(typeof adapter.testEnvironment).toBe("function");
  expect(typeof adapter.sessionCodec?.deserialize).toBe("function");
  expect(adapter.sessionManagement?.nativeContextManagement).toBe("confirmed");
  expect(typeof adapter.getConfigSchema).toBe("function");
});

test("Hermes adapter exposes bundled Proprio task bridge skill", async () => {
  const adapter = createServerAdapter();
  const snapshot = await adapter.listSkills?.({
    adapterType: "hermes_local",
    agentId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    config: {},
  });

  expect(snapshot?.entries.some((entry) => entry.runtimeName === "proprio-task-bridge")).toBe(true);
});

test("Hermes keeps the operational Proprio skill linked after an empty replacement", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-hermes-core-skill-"));
  try {
    const source = path.join(home, "runtime-skills", "proprio");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Proprio\n", "utf8");
    const adapter = createServerAdapter();
    const snapshot = await adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home },
        proprioRuntimeSkills: [{
          key: "groktopus/proprio/proprio",
          runtimeName: "proprio",
          source,
        }],
        proprioSkillSync: { desiredSkills: [] },
      },
    }, []);

    expect(snapshot?.desiredSkills).toContain("groktopus/proprio/proprio");
    expect((await fs.lstat(path.join(home, ".hermes", "skills", "proprio"))).isSymbolicLink()).toBe(true);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes starts across retained package upgrades and rollback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-hermes-core-upgrade-"));
  try {
    const makePackage = async (version: string, name = "@groktopus/server") => {
      const root = path.join(home, `package-${version}`);
      const source = path.join(root, "skills", "proprio");
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
        name,
        version,
        repository: { url: "https://github.com/groktopus/proprio" },
      }));
      await fs.writeFile(path.join(source, "SKILL.md"), version);
      return source;
    };
    const oldSource = await makePackage("1.0.0");
    const newSource = await makePackage("1.1.0");
    const unrelated = await makePackage("1.2.0", "my-hermes-skills");
    const target = path.join(home, ".hermes", "skills", "proprio");
    await fs.writeFile(path.join(home, "chat"), "console.log('ok');\n");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(oldSource, target, process.platform === "win32" ? "junction" : "dir");
    const adapter = createServerAdapter();
    const start = (source: string) => adapter.execute({
      runId: "hermes-package-upgrade",
      agent: {
        id: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
        name: "Hermes",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: process.execPath,
        cwd: home,
        provider: "auto",
        env: { HOME: home },
        proprioRuntimeSkills: [{ key: "groktopus/proprio/proprio", runtimeName: "proprio", source }],
      },
      context: {},
      onLog: async () => undefined,
    });

    await expect(start(newSource)).resolves.toMatchObject({ exitCode: 0 });
    expect(await fs.readlink(target)).toBe(newSource);
    const installed = await fs.lstat(target);
    await expect(start(newSource)).resolves.toMatchObject({ exitCode: 0 });
    expect((await fs.lstat(target)).ino).toBe(installed.ino);

    await expect(start(oldSource)).resolves.toMatchObject({ exitCode: 0 });
    expect(await fs.readlink(target)).toBe(oldSource);
    expect(await fs.readFile(path.join(newSource, "SKILL.md"), "utf8")).toBe("1.1.0");

    await fs.unlink(target);
    await fs.symlink(unrelated, target, process.platform === "win32" ? "junction" : "dir");
    await expect(start(newSource)).rejects.toThrow("occupied by another installation");
    expect(await fs.readlink(target)).toBe(unrelated);

    await fs.unlink(target);
    const dangling = path.join(home, "removed-user-skill");
    await fs.symlink(dangling, target, process.platform === "win32" ? "junction" : "dir");
    await expect(start(newSource)).rejects.toThrow("occupied by another installation");
    expect(await fs.readlink(target)).toBe(dangling);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes updates a link to a retained version of the same company skill", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-hermes-cache-upgrade-"));
  const companyId = "22222222-2222-4222-8222-222222222222";
  const skillId = "33333333-3333-4333-8333-333333333333";
  const oldId = "44444444-4444-4444-8444-444444444444";
  const newId = "55555555-5555-4555-8555-555555555555";
  const skillRoot = path.join(home, "instances", "test", "skills", companyId, "__versions__", skillId);
  const oldSource = path.join(skillRoot, oldId);
  const newSource = path.join(skillRoot, newId);
  const target = path.join(home, ".hermes", "skills", "proprio");

  vi.stubEnv("PROPRIO_HOME", home);
  vi.stubEnv("PROPRIO_INSTANCE_ID", "test");
  try {
    for (const directory of [oldSource, newSource]) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), "# Proprio\n");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(oldSource, target, process.platform === "win32" ? "junction" : "dir");
    const adapter = createServerAdapter();
    const sync = (source: string, versionId?: string) => adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId,
      config: {
        env: { HOME: home },
        proprioRuntimeSkills: [{
          key: "groktopus/proprio/proprio",
          runtimeName: "proprio",
          source,
          versionId,
        }],
      },
    }, []);

    await sync(newSource, newId);
    expect(await fs.readlink(target)).toBe(newSource);
    await sync(oldSource, oldId);
    expect(await fs.readlink(target)).toBe(oldSource);
    await fs.rm(oldSource, { recursive: true });
    await sync(newSource, newId);
    expect(await fs.readlink(target)).toBe(newSource);

    const retainedPackage = path.join(home, "published-proprio");
    const packagedSource = path.join(retainedPackage, "skills", "proprio");
    await fs.mkdir(packagedSource, { recursive: true });
    await fs.writeFile(path.join(packagedSource, "SKILL.md"), "# Proprio from the retained package\n");
    await fs.writeFile(path.join(retainedPackage, "package.json"), JSON.stringify({
      name: "@groktopus/server", version: "1.0.0", repository: { url: "https://github.com/groktopus/proprio" },
    }));

    await sync(packagedSource);
    expect(await fs.readlink(target)).toBe(packagedSource);
    await sync(newSource, newId);
    expect(await fs.readlink(target)).toBe(newSource);
    await sync(packagedSource);
    expect(await fs.readlink(target)).toBe(packagedSource);

    await fs.unlink(target);
    const foreignSource = path.join(skillRoot, "..", "66666666-6666-4666-8666-666666666666", oldId);
    await fs.symlink(foreignSource, target, process.platform === "win32" ? "junction" : "dir");
    await expect(sync(newSource, newId)).rejects.toThrow("occupied by another installation");
    expect(await fs.readlink(target)).toBe(foreignSource);
  } finally {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes rejects a conflicting operational skill target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-hermes-core-conflict-"));
  try {
    const source = path.join(home, "runtime-skills", "proprio");
    const target = path.join(home, ".hermes", "skills", "proprio");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Proprio\n", "utf8");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "SKILL.md"), "# Conflicting skill\n", "utf8");
    const adapter = createServerAdapter();

    await expect(adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home },
        proprioRuntimeSkills: [{
          key: "groktopus/proprio/proprio",
          runtimeName: "proprio",
          source,
        }],
      },
    }, [])).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Hermes rejects a live symlink owned by another operational skill", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "proprio-hermes-core-link-conflict-"));
  try {
    const source = path.join(home, "runtime-skills", "proprio");
    const conflictingSource = path.join(home, "external-skills", "proprio");
    const target = path.join(home, ".hermes", "skills", "proprio");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "# Proprio\n", "utf8");
    await fs.mkdir(conflictingSource, { recursive: true });
    await fs.writeFile(path.join(conflictingSource, "SKILL.md"), "# External skill\n", "utf8");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(conflictingSource, target);
    const adapter = createServerAdapter();

    await expect(adapter.syncSkills?.({
      adapterType: "hermes_local",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "22222222-2222-4222-8222-222222222222",
      config: {
        env: { HOME: home },
        proprioRuntimeSkills: [{
          key: "groktopus/proprio/proprio",
          runtimeName: "proprio",
          source,
        }],
      },
    }, [])).rejects.toThrow("occupied by another installation");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
