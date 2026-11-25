import { caseHandoffs, issueRecoveryActions, type Db } from "@groktopus/db";
import { CASE_HANDOFF_WITHDRAWAL_HOLD_CAUSE } from "@groktopus/shared";
import { conflict } from "../errors.js";
import { and, eq, inArray, or } from "drizzle-orm";

export const CASE_HANDOFF_OPEN_TRANSFER_STATES = ["awaiting_release", "pending_dispatch"] as const;
export const CASE_HANDOFF_OPEN_AGENT_STATES = ["offered", ...CASE_HANDOFF_OPEN_TRANSFER_STATES] as const;
export const CASE_HANDOFF_CANCELLABLE_STATES = [...CASE_HANDOFF_OPEN_AGENT_STATES, "awaiting_completion"] as const;
export const CASE_HANDOFF_SOURCE_FENCE_STATES = [...CASE_HANDOFF_OPEN_AGENT_STATES, "delivered"] as const;

export const CASE_HANDOFF_SUPERSEDED_REASON = "case_handoff_superseded";

export const CASE_HANDOFF_WITHDRAWN_AFTER_STOP = "operator_withdrawn_after_stop";

export function caseHandoffSourceFenceCondition() {
  return or(inArray(caseHandoffs.state, CASE_HANDOFF_SOURCE_FENCE_STATES),
    and(eq(caseHandoffs.state, "cancelled"), eq(caseHandoffs.lastErrorCode, CASE_HANDOFF_WITHDRAWN_AFTER_STOP)));
}

export async function assertCaseHandoffWithdrawalHoldReleased(
  db: Pick<Db, "select">, companyId: string, issueId: string,
) {
  const hold = await getCaseHandoffWithdrawalHold(db, companyId, issueId);
  if (hold) throw conflict(hold.nextAction, {
    code: CASE_HANDOFF_WITHDRAWAL_HOLD_CAUSE, recoveryActionId: hold.id,
  });
}

export async function getCaseHandoffWithdrawalHold(db: Pick<Db, "select">, companyId: string, issueId: string) {
  const [hold] = await db.select({ id: issueRecoveryActions.id, nextAction: issueRecoveryActions.nextAction })
    .from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.cause, CASE_HANDOFF_WITHDRAWAL_HOLD_CAUSE),
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
    )).limit(1);
  return hold ?? null;
}
