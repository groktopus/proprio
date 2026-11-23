import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mergeDiff } from "../../.github/scripts/ci-diff.mjs";

const durableWorkPaths = [
  /^(?:\.github\/workflows\/(?:stability-smoke|linux-source-qualification)\.yml|\.github\/scripts\/ci-diff\.mjs)$/,
  /^scripts\/ci\/(?:linux-source-qualification|durable-work-acceptance|assert-required-vitest-tests)/,
  /^cli\/src\/(?:commands\/(?:install|update|uninstall|db-backup|service)\.ts|install-store\.ts|onboard-service\.ts|checks\/(?:managed-install-check|service-health-check)\.ts|__tests__\/(?:install-command|install-store|update-command|managed-service-restart|db-backup)\.test\.ts)$/,
  /^packages\/db\/src\/(?:backup-lib[^/]*\.ts|client\.ts|migrations\/)/,
  /^server\/src\/(?:index\.ts|modules\/(?:run-dispatch|wake-queue)\/|services\/(?:heartbeat\/|heartbeat[^/]*\.ts$|native-runtime\/|recovery\/|runner-goals\.ts$|workspace-recovery[^/]*\.ts$|issue-continuation-summary\.ts$))/,
  /^packages\/(?:proprio-runner|adapter-utils\/src\/acpx-engine)\//,
  /^tests\/runner-recovery\//,
  /^(?:pnpm-lock\.yaml|\.nvmrc)$/,
];

export function requiresDurableWorkAcceptance(changedPaths) {
  return changedPaths.some(path => durableWorkPaths.some(pattern => pattern.test(path)));
}

export function assertDurableWorkGate(applicable, result) {
  if (applicable === "true" && result === "success") return;
  if (applicable === "false" && result === "skipped") return;
  throw new Error(`Durable-work acceptance did not satisfy the gate (applicable=${applicable}, result=${result})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, first, second] = process.argv.slice(2);
  switch (command) {
    case "route": {
      const { changed } = mergeDiff(first, second);
      const applicable = requiresDurableWorkAcceptance(changed);
      console.log(`Durable-work acceptance applicable: ${applicable}. PR head: ${second}`);
      appendFileSync(process.env.GITHUB_OUTPUT, `applicable=${applicable}\n`);
      break;
    }
    case "gate":
      assertDurableWorkGate(first, second);
      break;
    default:
      throw new Error("Expected the route or gate command");
  }
}
