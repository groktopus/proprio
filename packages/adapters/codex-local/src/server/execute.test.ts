import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxManagedRuntimeAsset } from "@groktopus/adapter-utils/sandbox-managed-runtime";

// Captured Codex `home` asset descriptor + the sandbox `auth.json` fixture the
// mocked runtime hands back during teardown. Mutated per-test so a single
// harness drives every round-trip case through the REAL `execute()` wiring.
const captured: { assets: SandboxManagedRuntimeAsset[] } = { assets: [] };
const sandboxAuthFixture: { bytes: Buffer } = { bytes: Buffer.from("{}") };
const REMOTE_RUNTIME_ROOT = "/remote/workspace/.proprio-runtime/codex";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  readProprioRuntimeSkillEntries,
  bundledRuntimeSkillEntries,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetProprioBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  readProprioRuntimeSkillEntries: vi.fn(async (config: Record<string, unknown>) =>
    Array.isArray(config.proprioRuntimeSkills) ? config.proprioRuntimeSkills : bundledRuntimeSkillEntries.entries),
  bundledRuntimeSkillEntries: { entries: [] as Array<{ key: string; runtimeName: string; source: string }> },
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  startAdapterExecutionTargetProprioBridge: vi.fn(async () => null),
}));

vi.mock("@groktopus/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@groktopus/adapter-utils/server-utils")>(
    "@groktopus/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    readProprioRuntimeSkillEntries,
    runChildProcess,
  };
});

vi.mock("@groktopus/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@groktopus/adapter-utils/execution-target")>(
    "@groktopus/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetProprioBridge,
  };
});

import { ensureCodexSkillsInjected, execute } from "./execute.js";

describe("Codex skill reconciliation ownership", () => {
  it("reconciles an unselected link only when the Codex home is isolated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-reconcile-"));
    try {
      const skillsHome = path.join(root, "codex", "skills");
      const source = path.join(root, "runtime", "skills", "review");
      await mkdir(skillsHome, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "private runtime skill\n");
      const target = path.join(skillsHome, "review");
      await symlink(source, target);
      const common = {
        skillsHome,
        skillsEntries: [],
        managedSkillEntries: [{ key: "review", runtimeName: "review", source }],
        desiredSkillNames: [],
      };

      await ensureCodexSkillsInjected(async () => undefined, common);
      expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("private runtime skill\n");

      await ensureCodexSkillsInjected(async () => undefined, { ...common, reconcileUnselected: true });
      await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not unlink a live custom skill from another checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-ownership-"));
    try {
      const skillsHome = path.join(root, "codex", "skills");
      const otherCheckout = path.join(root, "other-checkout");
      const externalSkill = path.join(otherCheckout, "skills", "review");
      await mkdir(skillsHome, { recursive: true });
      await mkdir(externalSkill, { recursive: true });
      await mkdir(path.join(otherCheckout, "server"), { recursive: true });
      await mkdir(path.join(otherCheckout, "packages", "adapter-utils"), { recursive: true });
      await writeFile(path.join(otherCheckout, "pnpm-workspace.yaml"), "packages: []\n");
      await writeFile(path.join(otherCheckout, "package.json"), "{}\n");
      await writeFile(path.join(externalSkill, "SKILL.md"), "operator skill\n");
      const link = path.join(skillsHome, "review");
      await symlink(externalSkill, link);

      await ensureCodexSkillsInjected(async () => undefined, {
        skillsHome,
        skillsEntries: [],
        managedSkillEntries: [],
        desiredSkillNames: [],
      });

      expect(await readFile(path.join(link, "SKILL.md"), "utf8")).toBe("operator skill\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Mirror the sandbox core's restore closure: capture the assets `execute()`
// declares, then during teardown invoke each asset's `restore` with an injected
// `readFile` (returns the sandbox fixture) and the remote asset dir. This drives
// the exact `restore` contribution the Codex adapter wires in production without
// needing a live sandbox.
prepareAdapterExecutionTargetRuntime.mockImplementation(async (input: { assets?: SandboxManagedRuntimeAsset[] }) => {
  captured.assets = input.assets ?? [];
  return {
    target: { kind: "remote", transport: "ssh" },
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: REMOTE_RUNTIME_ROOT,
    assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
    restoreWorkspace: async () => {
      for (const asset of captured.assets) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: `${REMOTE_RUNTIME_ROOT}/home`,
          readFile: async () => sandboxAuthFixture.bytes,
        });
      }
    },
  };
});

describe("codex execute — outbound auth copy-back restore contribution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    bundledRuntimeSkillEntries.entries = [];
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker: string }): string {
    return JSON.stringify(
      {
        tokens: {
          id_token: `id-token-${input.marker}`,
          access_token: `access-token-${input.marker}`,
          refresh_token: `refresh-token-${input.marker}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      },
      null,
      2,
    );
  }

  async function runTeardown(input: { sandboxAuth: string; hostAuth: string; onProviderStopped?: () => Promise<void>; withIdentity?: boolean; env?: Record<string, string>; config?: Record<string, unknown>; managedHome?: boolean; seedUnselectedPackagedSkill?: boolean }) {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "proprio-codex-copyback-e2e-"),
    );
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    // The shared host home is what `resolveSharedCodexHomeDir` returns
    // (process.env.CODEX_HOME) — the copy-back target. Point it at a tmp dir so
    // the round-trip never touches the real host credential.
    const sharedHostHome = input.managedHome
      ? path.join(rootDir, "instances", "default", "companies", "company-1", "codex-home")
      : path.join(rootDir, "shared-codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sharedHostHome, { recursive: true });
    const hostAuthPath = path.join(sharedHostHome, "auth.json");
    await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });

    let seededSkillsHome: string | null = null;
    if (input.seedUnselectedPackagedSkill) {
      const source = path.join(rootDir, "runtime", "skills", "review");
      const connectorSkillDigest = "a".repeat(64);
      const selectedInventoryDigest = createHash("sha256").update(JSON.stringify({ connectorSkillDigest, skills: [] })).digest("hex");
      const credentialIdentity = createHash("sha256").update(input.hostAuth).digest("hex");
      const runtimeSkillDigest = createHash("sha256").update(JSON.stringify({
        runtimeSkillDigest: selectedInventoryDigest,
        credentialHome: sharedHostHome,
        credentialIdentity,
        selectedConfigDigest: null,
        apiKey: input.env?.OPENAI_API_KEY ?? null,
      })).digest("hex");
      const generatedHome = path.join(rootDir, "instances", "default", "companies", "company-1", "codex-home",
        "connector-runtimes", "agent-1", runtimeSkillDigest);
      const skillsHome = path.join(generatedHome, "skills");
      seededSkillsHome = skillsHome;
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "SKILL.md"), "revoked packaged skill\n");
      await mkdir(skillsHome, { recursive: true });
      await symlink(source, path.join(skillsHome, "review"));
      bundledRuntimeSkillEntries.entries = [{ key: "team/review", runtimeName: "review", source }];
    }

    vi.stubEnv("CODEX_HOME", sharedHostHome);
    vi.stubEnv("PROPRIO_HOME", rootDir);
    vi.stubEnv("PROPRIO_INSTANCE_ID", "default");
    sandboxAuthFixture.bytes = Buffer.from(input.sandboxAuth, "utf8");

    const commandArgs: string[] = [];
    const executionResult = await execute({
      runId: "run-copyback-e2e",
      ...(input.withIdentity ? {
        authToken: "assigned-run-token",
        agentIdentity: { keyId: "sha256:test", publicKeyPem: "public", privateKeyPem: "private" },
      } : {}),
      onMeta: async meta => { commandArgs.push(...(meta.commandArgs ?? [])); },
      onProviderStopped: input.onProviderStopped,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        engine: "cli",
    // In managedHome cases, exercise reconciliation under the company root;
    // otherwise keep the home external so auth seeding cannot rewrite the
    // copy-back fixture before teardown.
        ...input.config,
        env: { CODEX_HOME: sharedHostHome, ...input.env },
      },
      context: {
        proprioWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    return {
      commandArgs,
      finalHostAuth: await readFile(hostAuthPath, "utf8"),
      finalHostMode: (await lstat(hostAuthPath)).mode & 0o777,
      seededSkillsHome,
      executionResult,
    };
  }

  it("reuses the discovered packaged inventory to remove a revoked skill from managed home", async () => {
    readProprioRuntimeSkillEntries.mockClear();
    const result = await runTeardown({
      sandboxAuth: "{}",
      hostAuth: "{}",
      managedHome: true,
      seedUnselectedPackagedSkill: true,
      env: { OPENAI_API_KEY: "provider-key" },
      config: { proprioConnectorSkillDigest: "a".repeat(64), proprioRuntimeSkills: [] },
    });
    const packagedInventoryReads = readProprioRuntimeSkillEntries.mock.calls.filter(([config]) =>
      !Array.isArray(config.proprioRuntimeSkills));
    expect(packagedInventoryReads).toHaveLength(1);
    expect(result.seededSkillsHome).not.toBeNull();
    await expect(lstat(path.join(result.seededSkillsHome!, "review"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([true, false])("delivers configured service tokens to CLI shells while isolating host and provider credentials (identity: %s)", async (withIdentity) => {
    vi.stubEnv("DATABASE_URL", "postgres://operator:host-password@host/private");
    vi.stubEnv("HOST_DATABASE_PASSWORD", "host-password");
    const { commandArgs } = await runTeardown({ sandboxAuth: "{}", hostAuth: "{}", withIdentity,
      env: { SLACK_BOT_TOKEN: "assigned-tool-token", OPENAI_API_KEY: "provider-key-canary" },
    });
    const policy = commandArgs.find(arg => arg.startsWith("shell_environment_policy.include_only="));
    const keys = policy ? JSON.parse(policy.slice(policy.indexOf("=") + 1)) : [];
    expect(keys).toEqual(expect.arrayContaining(["SLACK_BOT_TOKEN", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS", "DENO_CERT", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"]));
    if (withIdentity) expect(keys).toEqual(expect.arrayContaining([
      "PROPRIO_API_KEY", "PROPRIO_AGENT_PRIVATE_KEY",
    ]));
    expect(keys).not.toContain("OPENAI_API_KEY");
    expect(keys).not.toContain("DATABASE_URL");
    expect(keys).not.toContain("HOST_DATABASE_PASSWORD");
    expect(commandArgs.join(" ")).not.toContain("assigned-run-token");
    expect(commandArgs.join(" ")).not.toContain("assigned-tool-token");
  });

  it("collects stopped-provider instruction edits before a throwing remote restore", async () => {
    const order: string[] = [];
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => ({
      target: { kind: "remote", transport: "ssh" }, workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT, assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => { order.push("restore"); throw new Error("restore failed"); },
    }));
    await expect(runTeardown({ sandboxAuth: "{}", hostAuth: "{}", onProviderStopped: async () => { order.push("collect"); } })).rejects.toThrow("restore failed");
    expect(order).toEqual(["collect", "restore"]);
  });

  it("collects after a failed provider exit before restoring its workspace", async () => {
    runChildProcess.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "provider failed", pid: 321, startedAt: new Date().toISOString() });
    const collected = vi.fn(async () => {});
    await runTeardown({ sandboxAuth: "{}", hostAuth: "{}", onProviderStopped: collected });
    expect(collected).toHaveBeenCalledOnce();
  });

  it("stops the bridge and restores the workspace when instruction collection rejects", async () => {
    const order: string[] = [];
    startAdapterExecutionTargetProprioBridge.mockResolvedValueOnce({
      env: {}, stop: async () => { order.push("bridge-stop"); },
    } as never);
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => ({
      target: { kind: "remote", transport: "ssh" }, workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT, assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => { order.push("restore"); },
    }));
    await expect(runTeardown({ sandboxAuth: "{}", hostAuth: "{}", onProviderStopped: async () => {
      order.push("collect");
      throw new Error("instruction collection failed");
    } })).rejects.toThrow("instruction collection failed");
    expect(order).toEqual(["collect", "bridge-stop", "restore"]);
  });

  it("declares a Codex `home` asset carrying both inbound provision and outbound restore contributions", async () => {
    await runTeardown({
      sandboxAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T01:00:00Z", marker: "s" }),
      hostAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T02:00:00Z", marker: "h" }),
    });

    const homeAsset = captured.assets.find((asset) => asset.key === "home");
    expect(homeAsset).toBeDefined();
    expect(homeAsset?.provision).toBeTruthy();
    expect(typeof homeAsset?.restore).toBe("function");
  });

  it("round-trips a strictly-newer same-identity sandbox auth.json to the shared host at 0600 on teardown", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "sandbox-newer",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "host-older",
    });

    const result = await runTeardown({ sandboxAuth, hostAuth });

    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(result.finalHostMode).toBe(0o600);
  });

  it("keeps the host auth.json when the sandbox copy is a tie or older on teardown", async () => {
    const cases = [
      {
        name: "tie",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "s-tie" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-tie" }),
      },
      {
        name: "older",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T01:00:00Z", marker: "s-old" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-new" }),
      },
    ];

    for (const entry of cases) {
      const result = await runTeardown({ sandboxAuth: entry.sandboxAuth, hostAuth: entry.hostAuth });
      expect(result.finalHostAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalHostMode, entry.name).toBe(0o600);
    }
  });

  it("surfaces workspace restore failure after successful provider execution", async () => {
    prepareAdapterExecutionTargetRuntime.mockResolvedValueOnce({
      target: { kind: "remote", transport: "ssh" },
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT,
      assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => {
        throw new Error("workspace copy-back failed");
      },
    });

    await expect(
      runTeardown({
        sandboxAuth: subscriptionAuth({ accountId: "acct", marker: "sandbox" }),
        hostAuth: subscriptionAuth({ accountId: "acct", marker: "host" }),
      }),
    ).rejects.toThrow("workspace copy-back failed");
  });

  it("preserves a provider failure when workspace restore also fails", async () => {
    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "provider failed first",
      pid: 321,
      startedAt: new Date().toISOString(),
    });
    prepareAdapterExecutionTargetRuntime.mockResolvedValueOnce({
      target: { kind: "remote", transport: "ssh" },
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT,
      assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => {
        throw new Error("workspace copy-back failed second");
      },
    });

    const result = await runTeardown({
      sandboxAuth: subscriptionAuth({ accountId: "acct", marker: "sandbox" }),
      hostAuth: subscriptionAuth({ accountId: "acct", marker: "host" }),
    });
    expect(result.executionResult.errorMessage).toBe("provider failed first");
  });
});
