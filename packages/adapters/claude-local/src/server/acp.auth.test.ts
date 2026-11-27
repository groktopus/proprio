import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionResult } from "@groktopus/adapter-utils";
import type { AdapterExecutionTarget } from "@groktopus/adapter-utils/execution-target";

// The remote setup tests inspect the staged home and bootstrap inputs.
const { remoteHomeFixture } = vi.hoisted(() => ({
  remoteHomeFixture: {
    runtimeInput: null as unknown,
    shellCalls: [] as unknown[],
    disposeRuntime: vi.fn(async () => {}),
    restoreWorkspace: vi.fn(async () => ({ restored: true })),
    shellError: null as Error | null,
  },
}));
const { probeAcpHello } = vi.hoisted(() => ({
  probeAcpHello: vi.fn<typeof import("./acp-hello-probe.js").probeClaudeAcpHello>(async () => ({ status: "passed" })),
}));

vi.mock("@groktopus/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@groktopus/adapter-utils/execution-target")>(
    "@groktopus/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    prepareAdapterExecutionTargetRuntime: vi.fn(async (input: Record<string, unknown>) => {
      remoteHomeFixture.runtimeInput = input;
      const runtimeRootDir = input.runtimeRootDir as string;
      return {
        target: input.target,
        workspaceRemoteDir: input.workspaceRemoteDir,
        runtimeRootDir,
        assetDirs: { "config-seed": `${runtimeRootDir}/config-seed` },
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace: remoteHomeFixture.restoreWorkspace,
        disposeRuntime: remoteHomeFixture.disposeRuntime,
      };
    }),
    runAdapterExecutionTargetShellCommand: vi.fn(async (...args: unknown[]) => {
      remoteHomeFixture.shellCalls.push(args);
      if (remoteHomeFixture.shellError) throw remoteHomeFixture.shellError;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() };
    }),
  };
});
vi.mock("./acp-hello-probe.js", () => ({ probeClaudeAcpHello: probeAcpHello }));

import {
  mapClaudeAcpAuthErrorCode,
  testClaudeAcpEnvironment,
} from "./acp.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "daytona",
  remoteCwd: "/home/daytona/proprio-workspace",
  runner: {
    execute: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: null,
      startedAt: new Date().toISOString(),
    }),
  },
};

afterEach(() => {
  vi.clearAllMocks();
  remoteHomeFixture.runtimeInput = null;
  remoteHomeFixture.shellCalls.length = 0;
  remoteHomeFixture.shellError = null;
  probeAcpHello.mockResolvedValue({ status: "passed" });
});

describe("mapClaudeAcpAuthErrorCode", () => {
  it("translates the generic acpx_auth_required code into claude_auth_required", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Claude requires login.",
      errorCode: "acpx_auth_required",
      errorMeta: { category: "auth", errorName: "Error" },
    };

    const mapped = mapClaudeAcpAuthErrorCode(engineResult);

    // The user interface run gate reads claude_auth_required to show the login
    // affordance on the default ACP path.
    expect(mapped.errorCode).toBe("claude_auth_required");
    // The mapping keeps every other field so diagnostics stay intact.
    expect(mapped.errorMessage).toBe("Claude requires login.");
    expect(mapped.errorMeta).toEqual({ category: "auth", errorName: "Error" });
  });

  it("leaves a different error code unchanged", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "acpx_runtime_error",
    };

    expect(mapClaudeAcpAuthErrorCode(engineResult).errorCode).toBe("acpx_runtime_error");
  });

  it("leaves a null error code unchanged", () => {
    const engineResult: AdapterExecutionResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorCode: null,
    };

    expect(mapClaudeAcpAuthErrorCode(engineResult).errorCode).toBeNull();
  });
});

describe("Claude ACP hello probe on local and SSH targets", () => {
  const sshTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "ssh",
    remoteCwd: "/home/user/proprio-workspace",
    spec: { host: "example.com", port: 22, username: "user" },
  } as unknown as AdapterExecutionTarget;

  // Clear the host proxy and host auth variables so a local probe reads a
  // deterministic env regardless of the machine that runs the suite.
  const CLEARED_HOST_ENV_KEYS = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "ANTHROPIC_BEDROCK_BASE_URL",
  ];
  let tempDir: string | null = null;
  let claudePath = "";
  let acpPath = "";
  let savedPath: string | undefined;
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "proprio-acp-localprobe-"));
    claudePath = path.join(tempDir, "claude");
    acpPath = path.join(tempDir, "claude-agent-acp");
    await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
    await writeFile(acpPath, "#!/bin/sh\nexit 0\n");
    await chmod(claudePath, 0o755);
    await chmod(acpPath, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = tempDir;
    savedEnv = {};
    for (const key of CLEARED_HOST_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    process.env.PATH = savedPath;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    tempDir = null;
  });

  it("emits an explicit OAuth-token check on the ACP lane when CLAUDE_CODE_OAUTH_TOKEN is set", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-secret" } },
      executionTarget: null,
      environmentName: null,
    });
    expect(result.checks.some((check) => check.code === "claude_oauth_token_configured")).toBe(true);
    // Every result names the target it probed, including the host case.
    expect(result.checks.some((check) => check.code === "claude_environment_target")).toBe(true);
    // The token value never enters a check.
    expect(JSON.stringify(result.checks)).not.toContain("oauth-token-secret");
  });

  it("probes an explicitly selected API key through the selected ACP server", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", env: { ANTHROPIC_API_KEY: "selected-test-key" } },
      executionTarget: null,
      environmentName: null,
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_anthropic_api_key_detected",
      level: "info",
      message: "Using the selected Claude API connection.",
      hint: undefined,
    }));
    expect(JSON.stringify(result.checks)).not.toContain("selected-test-key");
    expect(probeAcpHello).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      command: expect.stringContaining("claude-agent-acp"),
      env: expect.objectContaining({ ANTHROPIC_API_KEY: "selected-test-key", ANTHROPIC_MODEL: expect.any(String) }),
      target: null,
    }));
  });

  it("forwards configured Anthropic custom headers to the ACP probe", async () => {
    await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", env: { ANTHROPIC_CUSTOM_HEADERS: "X-Gateway: selected" } },
      executionTarget: null,
      environmentName: null,
    });
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Gateway: selected");
  });

  it("does not launch a caller-selected local ACP executable during setup", async () => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", agentCommand: process.execPath, env: { ANTHROPIC_API_KEY: "selected-test-key" } },
      executionTarget: null,
      environmentName: null,
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_login_probe_unavailable",
      message: "The configured local ACP command cannot be executed by a setup test.",
    }));
    expect(probeAcpHello).not.toHaveBeenCalled();
  });

  it.each([null, sandboxTarget])("does not pass setup when CLAUDE_CODE_EXECUTABLE is caller-configured but unauthorized (%s)", async (target) => {
    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp", env: { ANTHROPIC_API_KEY: "selected-test-key", CLAUDE_CODE_EXECUTABLE: process.execPath } },
      executionTarget: target,
      environmentName: null,
    });

    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_login_probe_unavailable",
      message: "The configured CLAUDE_CODE_EXECUTABLE cannot be authorized by a setup test.",
      level: "warn",
    }));
    expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(false);
    expect(probeAcpHello).not.toHaveBeenCalled();
    expect(remoteHomeFixture.runtimeInput).toBeNull();
    expect(remoteHomeFixture.shellCalls).toEqual([]);
  });

  it("keeps the selected key unqualified when the ACP turn is not positive", async () => {
    probeAcpHello.mockResolvedValueOnce({ status: "failed" });
    const result = await testClaudeAcpEnvironment({ companyId: "company-1", adapterType: "claude_local",
      config: { engine: "acp", model: "claude-sonnet-5", env: { ANTHROPIC_API_KEY: "selected-test-key" } },
      executionTarget: null, environmentName: null });
    expect(result.status).toBe("warn");
    expect(result.checks.some(check => check.code === "claude_hello_probe_passed")).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_acp_login_probe_unavailable", level: "warn" }));
  });

  it("forwards the exact selected model to ACP even when the host has a model override", async () => {
    process.env.ANTHROPIC_MODEL = "host-default-model";
    const result = await testClaudeAcpEnvironment({ companyId: "company-1", adapterType: "claude_local",
      config: { engine: "acp", model: "saved-agent-model", env: { ANTHROPIC_API_KEY: "selected-test-key" } },
      executionTarget: null, environmentName: null });
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed", level: "info" }));
    expect(probeAcpHello.mock.calls.at(-1)?.[0]?.env.ANTHROPIC_MODEL).toBe("saved-agent-model");
  });

  it("inherits the host model when the local adapter has no model selection", async () => {
    process.env.ANTHROPIC_MODEL = "host-default-model";
    await testClaudeAcpEnvironment({ companyId: "company-1", adapterType: "claude_local",
      config: { engine: "acp", env: { ANTHROPIC_API_KEY: "selected-test-key" } }, executionTarget: null, environmentName: null });
    expect(probeAcpHello.mock.calls.at(-1)?.[0]?.env.ANTHROPIC_MODEL).toBe("host-default-model");
  });

  it("runs the host login probe with the host ANTHROPIC_API_KEY on a local target", async () => {
    // A local ACP run inherits the host environment, so a host ANTHROPIC_API_KEY
    // authenticates the real run. The Test lane runs the login probe with the
    // same host key, so the probe env matches the credential the real run
    // receives. The probe then reports a real result, not a false auth-required.
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-key";

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp" },
      executionTarget: null,
      environmentName: null,
    });

    // The probe runs once with the host key, so it authenticates and reports no
    // false auth-required and no probe-unavailable check.
    expect(probeAcpHello).toHaveBeenCalledTimes(1);
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-host-key");
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(false);
    // The lane still reports that API-key auth is in use.
    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "claude_acp_anthropic_api_key_detected", level: "warn",
    }));
    expect(result.status).toBe("warn");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed", level: "info" }));
    // The host key value never enters a check.
    expect(JSON.stringify(result.checks)).not.toContain("sk-ant-host-key");
  });

  it("runs the host login probe with the host CLAUDE_CODE_OAUTH_TOKEN on a local target", async () => {
    // A local ACP run inherits the host environment, so a host subscription
    // OAuth token authenticates the real run. The Test lane runs the login probe
    // with the same host token, so the probe env matches the credential the real
    // run receives. The probe then reports a real result, not a false
    // auth-required.
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-host-token";

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp" },
      executionTarget: null,
      environmentName: null,
    });

    // The probe runs once with the host token, so it authenticates and reports
    // no false auth-required and no probe-unavailable check.
    expect(probeAcpHello).toHaveBeenCalledTimes(1);
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-host-token");
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(false);
    // The lane reports that the configured OAuth token is in use.
    expect(result.checks.some((check) => check.code === "claude_oauth_token_configured")).toBe(true);
    // The host token value never enters a check.
    expect(JSON.stringify(result.checks)).not.toContain("oauth-host-token");
  });

  it("runs the host login probe with the host ANTHROPIC_AUTH_TOKEN on a local target", async () => {
    // A local ACP run inherits the host environment, so a host bearer auth token
    // authenticates the real run. The Test lane runs the login probe with the
    // same host token, so the probe env matches the credential the real run
    // receives. The probe then reports a real result, not a false auth-required.
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-host-token";

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp" },
      executionTarget: null,
      environmentName: null,
    });

    // The probe runs once with the host token, so it authenticates and reports
    // no false auth-required and no probe-unavailable check.
    expect(probeAcpHello).toHaveBeenCalledTimes(1);
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.ANTHROPIC_AUTH_TOKEN).toBe("auth-host-token");
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(false);
    // The host token value never enters a check.
    expect(JSON.stringify(result.checks)).not.toContain("auth-host-token");
  });

  it("runs the host login probe with the host CLAUDE_CONFIG_DIR on a local target", async () => {
    // A local ACP run reads the stored Claude login from the host
    // CLAUDE_CONFIG_DIR. The Test lane runs the login probe with the same host
    // config dir, so the probe reads the same stored login the real run uses.
    // The probe then reports a real result, not a false auth-required.
    process.env.CLAUDE_CONFIG_DIR = "/host/claude/config";

    const result = await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp" },
      executionTarget: null,
      environmentName: null,
    });

    // The probe runs once with the host config dir, so it reads the stored login
    // and reports no false auth-required and no probe-unavailable check.
    expect(probeAcpHello).toHaveBeenCalledTimes(1);
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.CLAUDE_CONFIG_DIR).toBe("/host/claude/config");
    expect(result.checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(false);
    expect(result.checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(false);
  });

  it("never forwards host auth or config paths and stages an isolated remote config dir", async () => {
    // A remote target does not inherit the host environment, so the probe keeps
    // the deny-by-default env and never reads a host credential. The host token
    // and host config dir must never reach the remote probe env.
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-host-token";
    process.env.CLAUDE_CONFIG_DIR = "/host/claude/config";

    await testClaudeAcpEnvironment({
      companyId: "company-1",
      adapterType: "claude_local",
      config: { engine: "acp" },
      executionTarget: sshTarget,
      environmentName: null,
    });

    expect(probeAcpHello).toHaveBeenCalledTimes(1);
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.CLAUDE_CONFIG_DIR).toMatch(
      /^\/home\/user\/proprio-workspace\/\.proprio-runtime\/claude\/probes\/claude-acp-probe-home-[^/]+\/config$/,
    );
    expect(probeAcpHello.mock.calls[0]?.[0]?.env.CLAUDE_CONFIG_DIR).not.toBe("/host/claude/config");
  });

  it.each([sandboxTarget, sshTarget])("stages a private managed Claude home before a remote setup probe", async (target) => {
    const managedHome = await mkdtemp(path.join(os.tmpdir(), "proprio-managed-claude-home-"));
    try {
      await writeFile(path.join(managedHome, "settings.json"), "{}");
      probeAcpHello.mockImplementationOnce(async (probeInput) => {
        expect(remoteHomeFixture.disposeRuntime).not.toHaveBeenCalled();
        expect(probeInput.env.CLAUDE_CONFIG_DIR).toMatch(/\/\.proprio-runtime\/claude\/probes\/[^/]+\/config$/);
        return { status: "passed" };
      });
      const result = await testClaudeAcpEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: {
          engine: "acp",
          managedAiConnection: { method: "api_key" },
          env: { ANTHROPIC_API_KEY: "selected-test-key", CLAUDE_CONFIG_DIR: managedHome },
        },
        executionTarget: target,
        environmentName: null,
      });

      expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_hello_probe_passed", level: "info" }));
      expect(remoteHomeFixture.runtimeInput).toMatchObject({
        privateRuntime: true,
        retainRuntime: false,
        syncWorkspace: false,
        target,
      });
      const stagedAssets = (remoteHomeFixture.runtimeInput as { assets: Array<{ key: string; localDir: string }> }).assets;
      expect(stagedAssets).toEqual([expect.objectContaining({ key: "config-seed", localDir: managedHome })]);
      const probeCall = probeAcpHello.mock.calls[0]?.[0];
      expect(probeCall?.env.ANTHROPIC_API_KEY).toBe("selected-test-key");
      expect(probeCall?.env.CLAUDE_CONFIG_DIR).toBe(`${target.remoteCwd}/.proprio-runtime/claude/probes/${(remoteHomeFixture.runtimeInput as { runId: string }).runId}/config`);
      expect(remoteHomeFixture.shellCalls.length).toBeGreaterThan(0);
      expect(JSON.stringify(remoteHomeFixture.shellCalls)).not.toContain("selected-test-key");
      const shellOptions = remoteHomeFixture.shellCalls[0]?.[3] as { env: Record<string, string> };
      expect(shellOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(remoteHomeFixture.disposeRuntime).toHaveBeenCalledOnce();
    } finally {
      await rm(managedHome, { recursive: true, force: true });
    }
  });

  it("tears down staged managed home after a failed remote probe and withholds the positive check", async () => {
    const managedHome = await mkdtemp(path.join(os.tmpdir(), "proprio-managed-claude-home-"));
    try {
      probeAcpHello.mockResolvedValueOnce({ status: "failed" });
      const result = await testClaudeAcpEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: { engine: "acp", managedAiConnection: { method: "api_key" }, env: { ANTHROPIC_API_KEY: "selected-test-key", CLAUDE_CONFIG_DIR: managedHome } },
        executionTarget: sshTarget,
        environmentName: null,
      });
      expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(false);
      expect(result.checks).toContainEqual(expect.objectContaining({ code: "claude_acp_login_probe_unavailable", level: "warn" }));
      expect(remoteHomeFixture.disposeRuntime).toHaveBeenCalledOnce();
    } finally {
      await rm(managedHome, { recursive: true, force: true });
    }
  });

  it("cleans the staged runtime when remote config materialization fails", async () => {
    const managedHome = await mkdtemp(path.join(os.tmpdir(), "proprio-managed-claude-home-"));
    try {
      remoteHomeFixture.shellError = new Error("remote bootstrap failed");
      const result = await testClaudeAcpEnvironment({
        companyId: "company-1",
        adapterType: "claude_local",
        config: { engine: "acp", managedAiConnection: { method: "api_key" }, env: { ANTHROPIC_API_KEY: "selected-test-key", CLAUDE_CONFIG_DIR: managedHome } },
        executionTarget: sshTarget,
        environmentName: null,
      });
      expect(result.checks.some((check) => check.code === "claude_hello_probe_passed")).toBe(false);
      expect(probeAcpHello).not.toHaveBeenCalled();
      expect(remoteHomeFixture.disposeRuntime).toHaveBeenCalledOnce();
    } finally {
      await rm(managedHome, { recursive: true, force: true });
    }
  });
});
