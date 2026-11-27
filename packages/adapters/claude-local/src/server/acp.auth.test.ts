import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterExecutionResult } from "@groktopus/adapter-utils";
import type { AdapterExecutionTarget } from "@groktopus/adapter-utils/execution-target";

// A shared handle so each test can set the stub Claude hello-probe output the
// sandbox runner returns.
const { runAdapterExecutionTargetProcess, probeResult, remoteHomeFixture } = vi.hoisted(() => {
  const probeResult: {
    value: { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
    throwError: Error | null;
  } = {
    value: { exitCode: 1, stdout: "", stderr: "", timedOut: false },
    throwError: null,
  };
  return {
    probeResult,
    remoteHomeFixture: {
      runtimeInput: null as unknown,
      shellCalls: [] as unknown[],
      disposeRuntime: vi.fn(async () => {}),
      restoreWorkspace: vi.fn(async () => ({ restored: true })),
      shellError: null as Error | null,
    },
    runAdapterExecutionTargetProcess: vi.fn(async () => {
      if (probeResult.throwError) throw probeResult.throwError;
      return {
        exitCode: probeResult.value.exitCode,
        signal: null,
        timedOut: probeResult.value.timedOut,
        stdout: probeResult.value.stdout,
        stderr: probeResult.value.stderr,
        pid: 321,
        startedAt: new Date().toISOString(),
      };
    }),
  };
});
const { probeAcpHello } = vi.hoisted(() => ({
  probeAcpHello: vi.fn<typeof import("./acp-hello-probe.js").probeClaudeAcpHello>(async () => ({ status: "passed" })),
}));

vi.mock("@groktopus/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@groktopus/adapter-utils/execution-target")>(
    "@groktopus/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
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
  probeClaudeAcpSandboxLogin,
  testClaudeAcpEnvironment,
} from "./acp.js";
import { ADAPTER_AUTH_MISSING_CHECK_CODE } from "./auth-check.js";

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

const initLine =
  '{"type":"system","subtype":"init","cwd":"/home/daytona/proprio-workspace","session_id":"abc","tools":["Bash","Read"]}';

const loginRequiredStdout = [
  initLine,
  '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run `claude login` to authenticate.","session_id":"abc"}',
].join("\n");

const helloStdout = [
  initLine,
  '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
].join("\n");

// The real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid. The probe
// exits non-zero and the result event reports a 401 authentication failure with
// an "Invalid bearer token" message. A synthetic bearer marker rides along on a
// retry line, so the test can prove the raw probe text never reaches a check.
const invalidTokenMarker = "SUPERSECRETbearerMARKER";
const invalidTokenStdout = [
  initLine,
  `{"type":"system","subtype":"api_retry","attempt":1,"error_status":401,"error":"authentication_failed: bearer ${invalidTokenMarker} is invalid","session_id":"abc"}`,
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Failed to authenticate. API Error: 401 Invalid bearer token"}]},"session_id":"abc","error":"authentication_failed"}',
  '{"type":"result","subtype":"success","is_error":true,"api_error_status":401,"error":"authentication_failed","result":"Failed to authenticate. API Error: 401 Invalid bearer token","session_id":"abc"}',
].join("\n");

afterEach(() => {
  vi.clearAllMocks();
  remoteHomeFixture.runtimeInput = null;
  remoteHomeFixture.shellCalls.length = 0;
  remoteHomeFixture.shellError = null;
  probeAcpHello.mockResolvedValue({ status: "passed" });
  probeResult.value = { exitCode: 1, stdout: "", stderr: "", timedOut: false };
  probeResult.throwError = null;
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

describe("probeClaudeAcpSandboxLogin", () => {
  it("emits the canonical adapter_auth_missing check when the sandbox probe reports missing auth", async () => {
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    // The descriptive check stays for diagnostics.
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    // A missing-auth probe is a warning, not a failure, so the environment stays
    // testable and the user interface can offer login.
    expect(checks.every((check) => check.level === "warn")).toBe(true);
  });

  it("classifies an invalid or expired token as adapter_auth_missing without leaking the token", async () => {
    probeResult.value = { exitCode: 1, stdout: invalidTokenStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // An auth failure returns the canonical login gate code, not the
    // probe-could-not-run code.
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(false);
    // The raw probe text, including the bearer marker, never reaches a check.
    expect(JSON.stringify(checks)).not.toContain(invalidTokenMarker);
  });

  it("does not flag a healthy probe whose assistant text repeats a token phrase", async () => {
    // A healthy run prints an auth phrase in its answer text. The parsed result
    // is a success, so the probe stays healthy and offers no login gate.
    probeResult.value = {
      exitCode: 0,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello — note authentication_failed means an invalid bearer token"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"success","is_error":false,"result":"hello","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // The parsed result is a success, so no login gate and no probe-unavailable
    // check appears.
    expect(checks).toEqual([expect.objectContaining({ code: "claude_hello_probe_passed", level: "info" })]);
  });

  it("keeps a non-auth failed probe with a token phrase on the probe-unavailable path", async () => {
    // The probe fails on a transient upstream error and prints an auth phrase in
    // its assistant text. The parsed result is not an auth failure, so the probe
    // stays on the neutral probe-unavailable code, not the login gate.
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]},"session_id":"abc"}',
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: 503 service unavailable","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
    expect(checks.some((check) => check.code === "claude_acp_login_probe_unavailable")).toBe(true);
  });

  it("never renders an untrusted login URL with sensitive query or fragment text", async () => {
    // The sandbox prints a login-required line that carries a malicious URL. The
    // URL has a non-allowlisted host, a query, and a fragment, each with a
    // marker. The normalizer must reject the URL, so no marker reaches a check.
    probeResult.value = {
      exitCode: 1,
      stdout: [
        initLine,
        '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Please run `claude login`. Visit https://evil.example.com/claude-login?leak=SECRETQUERYmarker#SECRETFRAGmarker","session_id":"abc"}',
      ].join("\n"),
      stderr: "",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // The login-required checks still appear.
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(true);
    const checkText = JSON.stringify(checks);
    // No marker and no untrusted host reaches any check.
    expect(checkText).not.toContain("SECRETQUERYmarker");
    expect(checkText).not.toContain("SECRETFRAGmarker");
    expect(checkText).not.toContain("evil.example.com");
    // The hint falls back to the fixed `claude login` text.
    const authRequired = checks.find((check) => check.code === "claude_hello_probe_auth_required");
    expect(authRequired?.hint).toBe("Run `claude login` in this environment, then retry the probe.");
  });

  it("records a successful probe when the sandbox reports a healthy login", async () => {
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toEqual([expect.objectContaining({ code: "claude_hello_probe_passed", level: "info" })]);
  });

  it("does not record success for an empty probe result", async () => {
    probeResult.value = { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    const checks = await probeClaudeAcpSandboxLogin({ config: { engine: "acp" }, target: sandboxTarget });
    expect(checks).toEqual([expect.objectContaining({ code: "claude_acp_login_probe_unavailable", level: "warn" })]);
  });

  it("emits a distinct warn check, not a silent pass, when the probe cannot run", async () => {
    probeResult.throwError = new Error("claude command not found");

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    // A probe that cannot run must not report a success. It emits a distinct
    // warn check that is NOT the login affordance code.
    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    expect(checks[0]?.level).toBe("warn");
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });

  it("emits a distinct warn check when the probe times out", async () => {
    probeResult.value = { exitCode: null as unknown as number, stdout: "", stderr: "", timedOut: true };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    expect(checks[0]?.level).toBe("warn");
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });

  it("emits a distinct warn check when the probe runs but does not complete", async () => {
    // The probe ran, login is not detected, and the exit code is non-zero. This
    // is not a healthy login, so it must not be a silent pass.
    probeResult.value = {
      exitCode: 1,
      stdout: initLine,
      stderr: "unexpected sandbox error",
      timedOut: false,
    };

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    expect(checks).toHaveLength(1);
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    expect(checks[0]?.level).toBe("warn");
  });

  it("never copies a thrown probe error into a Test-result check or the log", async () => {
    // A sandbox transport failure can carry a credential. Inject an opaque
    // credential marker and a proxy marker through the thrown error, then assert
    // no check text and no log call repeats either one.
    const opaqueCredMarker = "OPAQUECREDMARKERnoshape";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";
    probeResult.throwError = new Error(
      `transport failed with ${opaqueCredMarker} via ${proxyMarker}`,
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    // The log carries only the fixed context, the allowlisted classification,
    // and a safe error class name. It never repeats the raw error text.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });

  it("never copies raw probe stderr or stdout into a Test-result check or the log", async () => {
    // A non-zero probe can print an opaque credential to stdout and a proxy URL
    // to stderr. Inject one marker in each stream and assert neither reaches a
    // check or the log.
    const opaqueCredMarker = "OPAQUECREDMARKERstream";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";
    probeResult.value = {
      exitCode: 2,
      stdout: [initLine, `note: ${opaqueCredMarker}`].join("\n"),
      stderr: `fatal: proxy connect failed ${proxyMarker}`,
      timedOut: false,
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await probeClaudeAcpSandboxLogin({
      config: { engine: "acp" },
      target: sandboxTarget,
    });

    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");
    expect(checks[0]?.code).toBe("claude_acp_login_probe_unavailable");
    // The log carries only the fixed context, the allowlisted classification,
    // and the safe exit code. It never repeats the raw stream text.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "nonzero_exit",
      exitCode: 2,
    });
    warnSpy.mockRestore();
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
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };
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

  it("runs on a local target and reports auth-required without the sandbox-only adapter_auth_missing", async () => {
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "", timedOut: false };
    const checks = await probeClaudeAcpSandboxLogin({ config: { engine: "acp" }, target: null });
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });

  it("runs on an SSH target and reports auth-required without adapter_auth_missing", async () => {
    probeResult.value = { exitCode: 1, stdout: loginRequiredStdout, stderr: "", timedOut: false };
    const checks = await probeClaudeAcpSandboxLogin({ config: { engine: "acp" }, target: sshTarget });
    expect(checks.some((check) => check.code === "claude_hello_probe_auth_required")).toBe(true);
    expect(checks.some((check) => check.code === ADAPTER_AUTH_MISSING_CHECK_CODE)).toBe(false);
  });

  it("spawns the trusted resolved claude and drops hostile caller env on a local probe", async () => {
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };
    process.env.HTTPS_PROXY = "http://trusted-proxy:8443";

    await probeClaudeAcpSandboxLogin({
      config: {
        engine: "acp",
        env: {
          ANTHROPIC_API_KEY: "keep-this-key",
          NODE_OPTIONS: "--require /hostile/evil.js",
          PATH: "/hostile/bin",
          LD_PRELOAD: "/hostile/evil.so",
          HTTP_PROXY: "http://caller-proxy:8080",
        },
      },
      target: null,
    });

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as unknown[];
    const spawnedCommand = call[2] as string;
    const spawnedEnv = (call[4] as { env: Record<string, string> }).env;
    // The trusted resolved claude executable, never the caller command path.
    expect(spawnedCommand).toBe(claudePath);
    // The approved key reaches the child; the hostile keys never do.
    expect(spawnedEnv.ANTHROPIC_API_KEY).toBe("keep-this-key");
    expect(spawnedEnv.NODE_OPTIONS).toBeUndefined();
    expect(spawnedEnv.PATH).toBeUndefined();
    expect(spawnedEnv.LD_PRELOAD).toBeUndefined();
    expect(spawnedEnv.HTTP_PROXY).toBeUndefined();
    // The trusted proxy reaches the child; the caller proxy never does.
    expect(spawnedEnv.HTTPS_PROXY).toBe("http://trusted-proxy:8443");
    expect(JSON.stringify(spawnedEnv)).not.toContain("caller-proxy");
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
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

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
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

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
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

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
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

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
    probeResult.value = { exitCode: 0, stdout: helloStdout, stderr: "", timedOut: false };

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
