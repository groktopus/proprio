import { runHasPendingStop, runHasUnverifiedProviderStop } from "../agent-run-cancellation.js";
import { readProcessStartedAt } from "./hot-restart.js";
import { readLeaseReleaseDeferral } from "./environment-lease-release-deferral.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@groktopus/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

import { candidateRunScopes, hasStartupExecutionEvidence, RETAINED_RUNNER_PROFILE_KEYS } from "./pre-dispatch-execution-evidence.js";
import { readRunCancellation } from "./run-cancellation.js";
import { hasPendingBudgetRunCancellation } from "./heartbeat/budget-cancellation.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Historical startup cancellations may lack an adapter Stop receipt. This
 * proof is for lifecycle cleanup only. It cannot authorize replay. */
function isSettledLegacyStartupCancellation(run: Run): boolean {
  const startup = run.resultJson?.startupCancellation as Record<string, unknown> | undefined;
  const cancellation = readRunCancellation(run.resultJson);
  if (run.executionStage !== "settled" || !run.startedAt || !run.finishedAt ||
      startup?.beforeNativeSelection !== false || typeof startup.requestedAt !== "string" ||
      cancellation?.expected !== true ||
      !["operator", "queued_message", "control_plane"].includes(cancellation.source) ||
      startup.errorCode !== "continuation_task_ownership_changed" || startup.errorCode !== run.errorCode ||
      runHasPendingStop(run) || hasPendingBudgetRunCancellation(startup)) return false;

  const requestedAt = Date.parse(startup.requestedAt);
  if (!Number.isFinite(requestedAt) || requestedAt < run.startedAt.getTime() ||
      requestedAt > run.finishedAt.getTime()) return false;

  const recovery = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
  if (run.processStartedAt || run.sessionIdAfter || run.nativeIssueId || run.nativeSessionId ||
      run.nativePhase || run.runnerInstanceId || run.externalRunId || run.exitCode !== null || run.signal ||
      run.lastOutputAt || run.lastOutputSeq > 0 || run.stdoutExcerpt || run.stderrExcerpt ||
      run.usageJson?.budgetDispatch != null || recovery?.providerWorkStarted === true ||
      run.resultJson?.workspaceRestoreFailure != null || run.resultJson?.workspaceRestoreRecovery != null ||
      RETAINED_RUNNER_PROFILE_KEYS.some(key => run.runnerProfileJson?.[key] != null)) return false;
  return true;
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return (await agentExecutionStopBlocker(db, agentIds)) === null;
}

export async function agentExecutionStopBlocker(db: Db, agentIds: string[]): Promise<string | null> {
  if (!agentIds.length) return null;
  const runs = await db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(inArray(heartbeatRuns.agentId, agentIds));
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  const deferred = leases.find(lease => lease.status === "active" && readLeaseReleaseDeferral(lease.metadata));
  if (deferred) return `environment_lease_release_deferred:${readLeaseReleaseDeferral(deferred.metadata)!.reason}`;
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return "environment_lease_unreleased";
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return "native_finalization_owned";
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return "native_controller_alive";
  }
  const legacyStartupCandidates: Run[] = [];
  for (const run of runs) {
    if (run.runtimeMode === "legacy" &&
        runHasUnverifiedProviderStop(run))
      return "provider_stop_unconfirmed";
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return "run_not_terminal";
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return "run_controller_lease_held";
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return "remote_stop_unconfirmed";
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return "run_process_alive";
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return "native_stop_unproven";
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) {
      if (runLeases.length || coordinators.some(row => row.runId === run.id) ||
          !isSettledLegacyStartupCancellation(run)) return "legacy_stop_unproven";
      legacyStartupCandidates.push(run);
    }
  }
  if (legacyStartupCandidates.length) {
    // Check the whole candidate set with two bounded-result reads, regardless
    // of how many cancelled preparations the agents retained.
    const [executionStarted, nativeResults] = await Promise.all([
      hasStartupExecutionEvidence(db, legacyStartupCandidates),
      db.select({ id: nativeRunResults.id }).from(nativeRunResults).where(
        sql`(${nativeRunResults.runId}, ${nativeRunResults.companyId}) in (${candidateRunScopes(legacyStartupCandidates)})`,
      ).limit(1),
    ]);
    if (executionStarted || nativeResults.length) return "legacy_stop_unproven";
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        sql`date_trunc('milliseconds', ${nativeRunFinalizations.leaseExpiresAt}) = ${coordinator.leaseExpiresAt!.toISOString()}::timestamptz`,
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return "native_finalization_release_raced";
  }
  return null;
}
