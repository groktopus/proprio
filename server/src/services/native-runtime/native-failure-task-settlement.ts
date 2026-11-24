import type { Db } from "@groktopus/db";
import { issues } from "@groktopus/db";
import type { IssueStatus } from "@groktopus/shared";
import { eq } from "drizzle-orm";
import { issueService } from "../issues.js";
import { notifyNativeStatusReassessment } from "../native-status-reassessment-notifications.js";

type NativeFailureTask = typeof issues.$inferSelect | undefined;
type NativeFailureTaskTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Apply the issue-side effects of a native failure only while the locked issue
 * row still belongs to this run. The caller locks the issue before settling
 * the native coordinator/run rows, preserving the issue → coordinator → run
 * lock order.
 */
export async function settleNativeFailureTask(
  tx: NativeFailureTaskTransaction,
  input: {
    failureTask: NativeFailureTask;
    agentId: string;
    companyId: string;
    issueId: string;
    runId: string;
    phase: "retryable_failure" | "terminal_failure";
    ownershipUnverified: boolean;
    recoveryIssueStatus: IssueStatus | null;
    now: Date;
  },
): Promise<{ stillOwnsTask: boolean; failureBlockStatusVersion?: number }> {
  const { failureTask } = input;
  const stillOwnsTask =
    failureTask?.assigneeAgentId === input.agentId &&
    ["in_progress", "in_review"].includes(failureTask.status) &&
    (!failureTask.executionRunId || failureTask.executionRunId === input.runId) &&
    (!failureTask.checkoutRunId || failureTask.checkoutRunId === input.runId);

  let failureBlockStatusVersion: number | undefined;
  if (stillOwnsTask && input.recoveryIssueStatus) {
    const projected = await issueService(tx as unknown as Db).update(
      input.issueId,
      { status: input.recoveryIssueStatus },
      tx,
    );
    if (projected?.status === "blocked") failureBlockStatusVersion = projected.statusVersion;
  }

  if (!input.ownershipUnverified && stillOwnsTask && input.phase === "terminal_failure") {
    await notifyNativeStatusReassessment(tx, { companyId: input.companyId, issueId: input.issueId });
    await tx
      .update(issues)
      .set({ executionRunId: null, checkoutRunId: null, updatedAt: input.now })
      .where(eq(issues.id, input.issueId));
  }

  return {
    stillOwnsTask,
    ...(failureBlockStatusVersion !== undefined ? { failureBlockStatusVersion } : {}),
  };
}
