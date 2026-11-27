import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "../execution-target.js";

const { fixture } = vi.hoisted(() => {
  const fixture = {
    ensureSession: vi.fn(async () => ({})),
    cancel: vi.fn(async () => { throw new Error("cancel failed"); }),
    close: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    runtimeOptions: vi.fn(),
    bridgeOptions: vi.fn(),
    sessionOptions: vi.fn(),
  };
  return { fixture };
});

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: (options: unknown) => {
    fixture.runtimeOptions(options);
    return {
    ensureSession: (options: unknown) => {
      fixture.sessionOptions(options);
      return fixture.ensureSession();
    },
    startTurn: () => ({
      result: Promise.resolve({ status: "failed", error: { message: "probe failed" } }),
      events: { async *[Symbol.asyncIterator]() {} },
      closeStream: async () => {},
      cancel: fixture.cancel,
    }),
    close: fixture.close,
    shutdown: fixture.shutdown,
    };
  },
  createAgentRegistry: () => ({}),
  createRuntimeStore: () => ({}),
}));

vi.mock("../execution-target.js", async () => {
  const actual = await vi.importActual<typeof import("../execution-target.js")>("../execution-target.js");
  return {
    ...actual,
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(async (options) => {
      fixture.bridgeOptions(options);
      return { agentCommand: "fixture-bridge", stop: fixture.stop };
    }),
  };
});

vi.mock("./stock-runtime-options.js", async () => {
  const actual = await vi.importActual<typeof import("./stock-runtime-options.js")>("./stock-runtime-options.js");
  return {
    ...actual,
    assertNoHostAcpxAuthEnvironment: () => {},
    stockAcpRuntimeOptions: (options: unknown) => options,
  };
});

import { runAcpProbeTurn } from "./probe-turn.js";

afterEach(() => vi.clearAllMocks());

describe("ACP probe cleanup", () => {
  it("attempts runtime, bridge, and temp-store cleanup after cancellation fails", async () => {
    const target: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fixture",
      remoteCwd: "/workspace",
      runner: { execute: async () => ({
        exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString(),
      }) },
    };
    const result = await runAcpProbeTurn({
      agent: "claude",
      command: "fixture-agent",
      env: {},
      target,
      timeoutMs: 100,
      prompt: "hello",
    });

    expect(result).toEqual({ status: "failed", text: "", toolCall: false });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  it("applies one deadline to session startup and cleans up after it expires", async () => {
    fixture.ensureSession.mockImplementationOnce(() => new Promise(() => {}));
    const result = await runAcpProbeTurn({
      agent: "claude",
      command: "fixture-agent",
      env: {},
      timeoutMs: 10,
      prompt: "hello",
    });

    expect(result).toEqual({ status: "timeout", text: "", toolCall: false });
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });

  it("launches remote commands through the target shell from a host-owned cwd", async () => {
    const remoteExecute = vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString() }));
    const target: AdapterExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: "/remote/only/workspace",
      runner: { execute: remoteExecute },
    };
    await runAcpProbeTurn({ agent: "claude", command: "claude-agent-acp --flag value", env: {}, target, timeoutMs: 100, prompt: "hello" });

    expect(fixture.bridgeOptions).toHaveBeenCalledWith(expect.objectContaining({
      command: "sh", args: ["-lc", "exec claude-agent-acp --flag value"], cwd: expect.stringMatching(/^\/tmp\/proprio-acp-probe-/),
    }));
    const runtimeOptions = fixture.runtimeOptions.mock.calls.at(-1)?.[0] as { cwd: string; spawnCwd?: string };
    expect(runtimeOptions.cwd).toMatch(/^\/tmp\/proprio-acp-probe-/);
    expect(runtimeOptions.spawnCwd).toMatch(/^.*proprio-acp-probe-/);
    expect(remoteExecute).toHaveBeenCalledTimes(2);
    expect(remoteExecute.mock.calls[0]?.[0].args?.join(" ")).toContain("umask 077");
    expect(remoteExecute.mock.calls[1]?.[0].args?.join(" ")).toContain("rm -rf -- /tmp/proprio-acp-probe-");
  });

  it("passes an optional caller-selected model only as ACP session configuration", async () => {
    await runAcpProbeTurn({ agent: "codex", command: "fixture-agent", env: {}, sessionOptions: { model: "gpt-5.6-sol" }, timeoutMs: 100, prompt: "hello" });
    expect(fixture.sessionOptions).toHaveBeenCalledWith(expect.objectContaining({
      sessionOptions: { allowedTools: [], maxTurns: 1, model: "gpt-5.6-sol" },
    }));
    expect(fixture.runtimeOptions.mock.calls.at(-1)?.[0]).toMatchObject({ agentEnvironment: expect.any(Function) });
  });
});
