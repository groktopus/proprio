import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "../execution-target.js";

const { fixture } = vi.hoisted(() => {
  const fixture = {
    ensureSession: vi.fn(async () => ({})),
    cancel: vi.fn(async () => { throw new Error("cancel failed"); }),
    close: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  return { fixture };
});

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: () => ({
    ensureSession: fixture.ensureSession,
    startTurn: () => ({
      result: Promise.resolve({ status: "failed", error: { message: "probe failed" } }),
      events: { async *[Symbol.asyncIterator]() {} },
      closeStream: async () => {},
      cancel: fixture.cancel,
    }),
    close: fixture.close,
    shutdown: fixture.shutdown,
  }),
  createAgentRegistry: () => ({}),
  createRuntimeStore: () => ({}),
}));

vi.mock("../execution-target.js", async () => {
  const actual = await vi.importActual<typeof import("../execution-target.js")>("../execution-target.js");
  return {
    ...actual,
    startAdapterExecutionTargetProcessSessionBridge: vi.fn(async () => ({ agentCommand: "fixture-bridge", stop: fixture.stop })),
  };
});

vi.mock("./stock-runtime-options.js", () => ({
  assertNoHostAcpxAuthEnvironment: () => {},
  stockAcpRuntimeOptions: (options: unknown) => options,
}));

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
      cwd: "/workspace",
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
      cwd: "/workspace",
      env: {},
      timeoutMs: 10,
      prompt: "hello",
    });

    expect(result).toEqual({ status: "timeout", text: "", toolCall: false });
    expect(fixture.shutdown).toHaveBeenCalledOnce();
  });
});
