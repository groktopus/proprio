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
try {
  const results = [];
  for (const issueId of issueIds) results.push(await recovery.assignedWork.checkIssue({ companyId, issueId }));
  process.stdout.write(`${JSON.stringify({ results })}\n`);
} finally {
  await db.$client.end({ timeout: 0 });
  // Queue admission is the observable effect under test. Do not wait for or
  // execute provider work in this worker: its purpose is the recovery cycle.
  process.exit(0);
}
