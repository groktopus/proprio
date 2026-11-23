import type { SessionStrategy } from "./sessions.js";

export interface BridgeLeaseConfig {
  keepAlive: boolean;
  sleepAfter: string;
  normalizeId: boolean;
}

export interface BridgeCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | null;
  timeoutMs?: number;
  sessionStrategy: SessionStrategy;
  sessionId?: string;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void | Promise<void>;
}

export interface BridgeCommandResult {
  exitCode: number | null;
  signal: null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface BridgeLease {
  setKeepAlive(keepAlive: boolean): Promise<void>;
  destroy(): Promise<void>;
  hasSentinel?(path: string, timeoutMs: number): Promise<boolean>;
  execute(command: BridgeCommand): Promise<BridgeCommandResult>;
}

export type ResolveBridgeLease = (id: string, config: BridgeLeaseConfig) => Promise<BridgeLease>;

export const DEFAULT_REMOTE_CWD = "/workspace/proprio";
export const DEFAULT_SESSION_ID = "proprio";
export const DEFAULT_TIMEOUT_MS = 300_000;

export function toJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function toErrorResponse(status: number, error: string, message: string): Response {
  return toJsonResponse({ error, message }, status);
}
