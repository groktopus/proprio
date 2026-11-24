import { createDb } from "@groktopus/db";
import { heartbeatService } from "../../services/heartbeat.js";
import { recoveryService } from "../../services/recovery/service.js";

const [connectionString, companyId, ...issueIds] = process.argv.slice(2);
if (!connectionString || !companyId || issueIds.length === 0) throw new Error("Expected database URL, company id, and issue id(s)");

// This worker is a fresh controller-side recovery cycle. The first instance is
// SIGKILLed by the registered production crash point; the second calls the same
// assigned-work entry with its committed claim still in Postgres.
const db = createDb(connectionString, { maxConnections: 4 });
const heartbeat = heartbeatService(db);
const recovery = recoveryService(db, {
  enqueueWakeup: (agentId, options) => heartbeat.wakeup(agentId, options),
});
let exitCode = 0;
try {
  const results = [];
  for (const issueId of issueIds) results.push(await recovery.assignedWork.checkIssue({ companyId, issueId }));
  await heartbeat.resumeQueuedRuns();
  await heartbeat.drainActiveRunExecutions();
  process.stdout.write(`${JSON.stringify({ results })}\n`);
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await db.$client.end({ timeout: 0 });
}
// Queue admission is the effect under test. The runner can deliver the wake
// in a later process without keeping this recovery worker alive.
process.exit(exitCode);
