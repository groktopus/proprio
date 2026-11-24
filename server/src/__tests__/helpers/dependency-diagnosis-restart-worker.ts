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
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`DIAGNOSIS_RESTART_RESULT ${JSON.stringify({ results })}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await db.$client.end({ timeout: 0 });
}
process.exit(exitCode);
