import { runAcpProbeTurn } from "@groktopus/adapter-utils/acpx-engine/probe-turn";
import type { AdapterExecutionTarget } from "@groktopus/adapter-utils/execution-target";

export type ClaudeAcpHelloProbeResult =
  | { status: "passed" }
  | { status: "auth_required" | "timeout" | "failed" };

/** Require a useful, tool-free hello response from the selected Claude ACP server. */
export async function probeClaudeAcpHello(input: {
  command: string;
  env: Record<string, string>;
  target: AdapterExecutionTarget | null;
  timeoutMs: number;
}): Promise<ClaudeAcpHelloProbeResult> {
  const turn = await runAcpProbeTurn({
    agent: "claude",
    command: input.command,
    env: input.env,
    target: input.target,
    timeoutMs: input.timeoutMs,
    maxResponseChars: 2_048,
    prompt: "Respond only with hello. Do not use tools or inspect files.",
  });
  if (turn.status === "completed" && !turn.toolCall && /\bhello\b/i.test(turn.text)) return { status: "passed" };
  return { status: turn.status === "completed" ? "failed" : turn.status };
}
