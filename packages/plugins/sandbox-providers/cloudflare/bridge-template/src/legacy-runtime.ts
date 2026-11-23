import { executeInSandbox } from "./exec.js";
import type { ResolveBridgeLease } from "./runtime.js";
import { applySandboxKeepAlive, resolveSandbox, type BridgeEnv } from "./sandboxes.js";

export function legacyRuntime(env: BridgeEnv): ResolveBridgeLease {
  return async (id, config) => {
    const sandbox = await resolveSandbox(env, id, config);
    return {
      setKeepAlive: keepAlive => applySandboxKeepAlive(sandbox, keepAlive),
      destroy: async () => { await sandbox.destroy(); },
      execute: command => executeInSandbox({ ...command, sandbox }),
    };
  };
}
