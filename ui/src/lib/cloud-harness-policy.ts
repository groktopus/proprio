import { agentRuntimeSettingsHarness } from "@groktopus/shared";
import { PROPRIO_RUNNER_ACPX_PROFILES } from "@groktopus/adapter-utils";

/** Deployment policy only restricts choices; adapter availability and qualification still apply. */
export function createCloudHarnessPolicy(availableHarnesses?: readonly string[]) {
  const allowed = availableHarnesses === undefined ? undefined : new Set(availableHarnesses);
  function isCloudHarnessAllowed(type: string, config: Record<string, unknown> = {}): boolean {
    return allowed === undefined || allowed.has(agentRuntimeSettingsHarness(type, config));
  }
  function isCloudRunnerProviderAllowed(provider: string, acpxAgent?: string): boolean {
    const profile = PROPRIO_RUNNER_ACPX_PROFILES.find(entry => entry.value === provider);
    return isCloudHarnessAllowed("proprio_runner", {
      provider: profile ? "acpx" : provider,
      acpxAgent: acpxAgent ?? profile?.value ?? (provider === "acpx" ? "claude" : provider),
    });
  }
  return { availableHarnesses, restricted: allowed !== undefined, isCloudHarnessAllowed, isCloudRunnerProviderAllowed };
}

export type CloudHarnessPolicy = ReturnType<typeof createCloudHarnessPolicy>;
export const unrestrictedCloudHarnessPolicy = createCloudHarnessPolicy();
