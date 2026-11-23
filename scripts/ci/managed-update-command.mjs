import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseManagedUpdateInvocation(args) {
  if (args.length === 3 && args[0] === "update" && args[1] === "--check" && args[2] === "--json") {
    return { check: true, json: true };
  }
  if (args.length === 2 && args[0] === "update" && args[1] === "--yes") {
    return { yes: true };
  }
  if (args.length === 2 && args[0] === "update" && args[1] === "--rollback") {
    return { rollback: true };
  }
  throw new Error(`Unsupported managed update qualification command: ${args.join(" ")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseManagedUpdateInvocation(process.argv.slice(2));
  const executablePath = process.env.E2E_MANAGED_EXECUTABLE;
  assert.ok(executablePath, "E2E_MANAGED_EXECUTABLE must name the active managed payload entrypoint");
  assert.ok(process.env.E2E_BOOTSTRAP_NODE_LOADER, "E2E_BOOTSTRAP_NODE_LOADER is required to load the reviewed TypeScript updater");
  assert.ok(existsSync(executablePath), `Managed payload entrypoint is missing: ${executablePath}`);

  const { updateCommand } = await import("../../cli/src/commands/update.ts");
  await updateCommand(options, { executablePath });
}
