import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcpRuntime, createAgentRegistry, createRuntimeStore } from "acpx/runtime";
import type { AcpRuntimeHandle, AcpRuntimeTurn } from "acpx/runtime";
import type { AdapterExecutionTarget } from "../execution-target.js";
import { runAdapterExecutionTargetShellCommand, startAdapterExecutionTargetProcessSessionBridge } from "../execution-target.js";
import { assertNoHostAcpxAuthEnvironment, splitWindowsAgentCommand, stockAcpRuntimeOptions } from "./stock-runtime-options.js";

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

function remainingProbeTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error("probe_timeout"), { code: "PROBE_TIMEOUT" });
  return remaining;
}

async function awaitProbeStartup<T>(operation: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("probe_timeout"), { code: "PROBE_TIMEOUT" })), remainingProbeTime(deadline));
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export type AcpProbeTurnResult =
  | { status: "completed"; text: string; toolCall: boolean }
  | { status: "auth_required" | "timeout" | "failed"; text: ""; toolCall: false };

/** Run one bounded, tool-free ACP turn through the selected agent command. */
export async function runAcpProbeTurn(input: {
  agent: string;
  command: string;
  env: Record<string, string>;
  sessionOptions?: { model?: string };
  target?: AdapterExecutionTarget | null;
  timeoutMs: number;
  maxResponseChars?: number;
  prompt: string;
}): Promise<AcpProbeTurnResult> {
  const deadline = Date.now() + input.timeoutMs;
  const root = await mkdtemp(path.join(tmpdir(), "proprio-acp-probe-"));
  // A credential probe must not read project-level Claude settings or run
  // project hooks from the agent's checkout. The probe needs no workspace IO.
  const runId = `acp-probe-${randomUUID()}`;
  let probeCwd = root;
  let remoteProbeCwd: string | null = null;
  let bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetProcessSessionBridge>> | null = null;
  let runtime: ReturnType<typeof createAcpRuntime> | undefined;
  let handle: AcpRuntimeHandle | undefined;
  let turn: AcpRuntimeTurn | undefined;
  let failure: AcpProbeTurnResult["status"] = "failed";
  let result: Extract<AcpProbeTurnResult, { status: "completed" }> | undefined;
  const probeEnv = { ...input.env };

  try {
    assertNoHostAcpxAuthEnvironment();
    let agentCommand = input.command;
    if (input.target?.kind === "remote") {
      remoteProbeCwd = path.posix.join("/tmp", `proprio-acp-probe-${randomUUID()}`);
      const createProbeCwd = await runAdapterExecutionTargetShellCommand(
        `${runId}-cwd`, input.target,
        `umask 077 && mkdir ${remoteProbeCwd} && chmod 700 ${remoteProbeCwd}`,
        { cwd: input.target.remoteCwd, env: {}, timeoutSec: Math.max(1, Math.ceil(remainingProbeTime(deadline) / 1000)) },
      );
      if (createProbeCwd.exitCode !== 0 || createProbeCwd.timedOut) throw new Error("could_not_create_probe_directory");
      probeCwd = remoteProbeCwd;
      bridge = await startAdapterExecutionTargetProcessSessionBridge({
        runId,
        target: input.target,
        runtimeRootDir: path.posix.join(input.target.remoteCwd, ".proprio-runtime", input.agent),
        adapterKey: input.agent,
        command: "sh",
        args: [input.target.transport === "ssh" ? "-c" : "-lc", `exec ${input.command}`],
        cwd: probeCwd,
        env: probeEnv,
        timeoutSec: Math.ceil(remainingProbeTime(deadline) / 1000),
      });
      if (!bridge) return { status: "failed", text: "", toolCall: false };
      agentCommand = bridge.agentCommand;
    }

    runtime = createAcpRuntime(stockAcpRuntimeOptions({
      cwd: probeCwd,
      ...(bridge ? { spawnCwd: root } : {}),
      sessionStore: createRuntimeStore({ stateDir: path.join(root, "state") }),
      agentRegistry: createAgentRegistry({ overrides: {
        [input.agent]: bridge
          ? [process.execPath, bridge.agentCommand].map(part => part.replaceAll("\\", "/"))
          : process.platform === "win32" ? splitWindowsAgentCommand(agentCommand) : agentCommand,
      } }),
      agentEnvironment: () => ({ PATH: process.env.PATH ?? "", ...probeEnv }),
      permissionMode: "deny-all",
      nonInteractivePermissions: "deny",
      fs: false,
      terminal: false,
      timeoutMs: remainingProbeTime(deadline),
    }));
    handle = await awaitProbeStartup(runtime.ensureSession({
      sessionKey: runId,
      agent: input.agent,
      mode: "oneshot",
      cwd: probeCwd,
      sessionOptions: { allowedTools: [], maxTurns: 1, ...input.sessionOptions },
    }), deadline);

    const response = { text: "", toolCall: false };
    turn = runtime.startTurn({
      handle,
      text: input.prompt,
      mode: "prompt",
      requestId: randomUUID(),
      timeoutMs: remainingProbeTime(deadline),
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
          const remaining = remainingProbeTime(deadline);
          timeoutTimer = setTimeout(() => reject(Object.assign(new Error("probe_timeout"), { code: "PROBE_TIMEOUT" })), remaining);
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
    // The one-shot turn retires its session owner when its result settles.
    // Calling close() here can open a second ACP transport for optional
    // session/close support after the relay's one-shot client has already
    // ended. shutdown() closes any remaining local owners without reconnecting.
    if (runtime && !(await cleanupWithinBudget(() => runtime!.shutdown()))) cleanupFailed = true;
    if (bridge && !(await cleanupWithinBudget(() => bridge!.stop()))) cleanupFailed = true;
    if (remoteProbeCwd && input.target?.kind === "remote" && !(await cleanupWithinBudget(async () => {
      const removed = await runAdapterExecutionTargetShellCommand(
        `${runId}-cwd-cleanup`, input.target, `rm -rf -- ${remoteProbeCwd}`,
        { cwd: input.target.remoteCwd, env: {}, timeoutSec: CLEANUP_TIMEOUT_MS / 1_000 },
      );
      if (removed.exitCode !== 0 || removed.timedOut) throw new Error("ACP probe directory cleanup failed");
    }))) cleanupFailed = true;
    if (!(await cleanupWithinBudget(() => rm(root, { recursive: true, force: true })))) cleanupFailed = true;
    if (cleanupFailed) result = undefined;
  }
  return result ?? { status: failure, text: "", toolCall: false };
}
