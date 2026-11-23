export const MANAGED_RESTART_LOCK_FILENAME = "hot-restart.lock";
export const MANAGED_RESTART_PROBE_HEADER = "x-proprio-service-restart-probe";
export const MANAGED_RESTART_PROOF_HEADER = "x-proprio-service-restart-proof";

export function managedRestartProbeMessage(
  challenge: string,
  healthy: boolean,
  serverVersion: string | null,
  commit: string | null,
): string {
  return JSON.stringify([challenge, healthy, serverVersion, commit]);
}
