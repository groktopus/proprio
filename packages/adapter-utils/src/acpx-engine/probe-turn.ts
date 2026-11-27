import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import type { AcpRuntimeHandle, AcpRuntimeTurn } from "acpx/runtime";
import type { AdapterExecutionTarget } from "../execution-target.js";
import { startAdapterExecutionTargetProcessSessionBridge } from "../execution-target.js";
import { assertNoHostAcpxAuthEnvironment, stockAcpRuntimeOptions } from "./stock-runtime-options.js";

const CLEANUP_TIMEOUT_MS = 10_000;

async function cleanupWithinBudget(cleanup: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([cleanup(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ACP probe cleanup timed out")), CLEANUP_TIMEOUT_MS);
    })]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export type AcpProbeTurnResult =
  | { status: "completed"; text: string; toolCall: boolean }
  | { status: "auth_required" | "timeout" | "failed"; text: ""; toolCall: false };

/** Run one bounded, tool-free ACP turn through the selected agent command. */
export async function runAcpProbeTurn(input: {
  agent: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  model?: string | null;
  target?: AdapterExecutionTarget | null;
  timeoutMs: number;
  maxResponseChars?: number;
  prompt: string;
}): Promise<AcpProbeTurnResult> {
  const root = await mkdtemp(path.join(tmpdir(), "proprio-acp-probe-"));
  const runId = `acp-probe-${randomUUID()}`;
  let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetProcessSessionBridge>> | null = null;
  let runtime: ReturnType<typeof createAcpRuntime> | undefined;
  let handle: AcpRuntimeHandle | undefined;
  let turn: AcpRuntimeTurn | undefined;
  let failure: AcpProbeTurnResult["status"] = "failed";
  let result: Extract<AcpProbeTurnResult, { status: "completed" }> | undefined;
  const probeEnv = { ...input.env, ...(input.model ? { ANTHROPIC_MODEL: input.model } : {}) };

  try {
    assertNoHostAcpxAuthEnvironment();
    let agentCommand = input.command;
    if (input.target?.kind === "remote") {
      bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId,
        target: input.target,
        runtimeRootDir: path.posix.join(input.target.remoteCwd, ".proprio-runtime", input.agent),
        adapterKey: input.agent,
        command: input.command,
        args: [],
        cwd: input.cwd,
        env: probeEnv,
        timeoutSec: Math.ceil(input.timeoutMs / 1000),
      });
      if (!bridge) return { status: "failed", text: "", toolCall: false };
      agentCommand = bridge.agentCommand;
    }

    runtime = createAcpRuntime(stockAcpRuntimeOptions({
      cwd: input.cwd,
      sessionStore: createRuntimeStore({ stateDir: path.join(root, "state") }),
      agentRegistry: createAgentRegistry({ overrides: { [input.agent]: agentCommand } }),
      agentEnvironment: () => ({ PATH: process.env.PATH ?? "", ...probeEnv }),
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      fs: false,
      terminal: false,
      timeoutMs: input.timeoutMs,
    }));
    handle = await runtime.ensureSession({
      sessionKey: runId,
      agent: input.agent,
      mode: "oneshot",
      cwd: input.cwd,
      sessionOptions: { ...(input.model ? { model: input.model } : {}), allowedTools: [], maxTurns: 1 },
    });

    const response = { text: "", toolCall: false };
    turn = runtime.startTurn({
      handle,
      text: input.prompt,
      mode: "prompt",
      requestId: randomUUID(),
      timeoutMs: input.timeoutMs,
    });
    const consume = (async () => {
      for await (const event of turn!.events) {
        if (event.type === "text_delta" && event.stream !== "thought") {
          response.text = `${response.text}${event.text}`.slice(-(input.maxResponseChars ?? 2_048));
        } else if (event.type === "tool_call") response.toolCall = true;
      }
    })();
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let outcome: Awaited<typeof turn.result>;
    try {
      outcome = await Promise.race([
        turn.result,
        new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(() => reject(Object.assign(new Error("probe_timeout"), { code: "PROBE_TIMEOUT" })), input.timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timeoutTimer); }
    // startTurn event streams do not emit terminal events. Close the stream
    // after the canonical result settles so the event consumer can finish.
    if (!(await cleanupWithinBudget(() => turn!.closeStream({ reason: "ACP probe turn complete" })))) {
      throw new Error("ACP probe event stream did not close");
    }
    if (!(await cleanupWithinBudget(() => consume))) throw new Error("ACP probe event consumer did not finish");
    if (outcome.status === "completed") result = { status: "completed", ...response };
    else if (outcome.status === "failed" && /(?:authentication|required|unauthorized|unauthenticated|\b(?:401|403)\b)/i.test(outcome.error.message)) failure = "auth_required";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "PROBE_TIMEOUT") failure = "timeout";
    else if (error instanceof Error && /(?:authentication|required|unauthorized|unauthenticated|\b(?:401|403)\b)/i.test(error.message)) failure = "auth_required";
  } finally {
    let cleanupFailed = false;
    if (turn && !result && !(await cleanupWithinBudget(() => turn!.cancel({ reason: "ACP probe ended" })))) cleanupFailed = true;
    if (runtime && handle && !(await cleanupWithinBudget(() => runtime!.close({ handle: handle!, reason: "ACP probe complete", discardPersistentState: true })))) cleanupFailed = true;
    if (runtime && !(await cleanupWithinBudget(() => runtime!.shutdown()))) cleanupFailed = true;
    if (bridge && !(await cleanupWithinBudget(() => bridge!.stop()))) cleanupFailed = true;
    if (!(await cleanupWithinBudget(() => rm(root, { recursive: true, force: true })))) cleanupFailed = true;
    if (cleanupFailed) result = undefined;
  }
  return result ?? { status: failure, text: "", toolCall: false };
}
