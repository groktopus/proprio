import type { BridgeLeaseConfig } from "./runtime.js";
import type { Sandbox as CloudflareSandbox } from "sandbox-0x";
import { getSandbox } from "sandbox-0x";
import { buildLeaseSandboxId, buildSentinelPath, isTimeoutError } from "./helpers.js";

export interface BridgeEnv {
  Sandbox: DurableObjectNamespace<CloudflareSandbox>;
  BRIDGE_AUTH_TOKEN?: string;
}

export async function resolveSandbox(
  env: BridgeEnv,
  sandboxId: string,
  config: BridgeLeaseConfig,
): Promise<CloudflareSandbox> {
  // Pure handle resolution: the constructor accepts keepAlive/sleepAfter so the
  // sandbox is created with the right defaults on first use, but we no longer
  // call `setKeepAlive` here. That side effect now lives in
  // `applySandboxKeepAlive` and is invoked only from lease-management routes,
  // so exec calls don't accidentally overwrite the lease's keepAlive policy.
  return getSandbox(env.Sandbox, sandboxId, {
    keepAlive: config.keepAlive,
    sleepAfter: config.sleepAfter,
  });
}

export async function applySandboxKeepAlive(
  sandbox: CloudflareSandbox,
  keepAlive: boolean,
): Promise<void> {
  await sandbox.setKeepAlive(keepAlive);
}

export { buildLeaseSandboxId, buildSentinelPath, isTimeoutError };
