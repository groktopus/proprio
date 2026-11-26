import { and, eq, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { activityLog, issues, type Db } from "@groktopus/db";
import type { AuthorizationActor } from "./authorization.js";
import { issueReadSqlCondition } from "./authorization.js";
import { withAuthorizationReadSnapshot } from "./authorization-read-scope.js";

export function budgetTaskTreeRootReadCondition(db: Db, actor: AuthorizationActor) {
  return withAuthorizationReadSnapshot(() => issueReadSqlCondition(db, actor));
}

export async function canReadBudgetTaskTreeRoot(db: Db, companyId: string, rootIssueId: string, actor: AuthorizationActor) {
  const readable = await budgetTaskTreeRootReadCondition(db, actor);
  const [root] = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId), readable, isNull(issues.harnessKind))).limit(1);
  return Boolean(root);
}

/** Task-tree budgets inherit the root task's privacy boundary. Hidden roots
 * still enforce their limits, so an authorized operator can manage them. */
export function readableTaskTreeBudgetCondition(readable: SQL<boolean>, scopeType: SQLWrapper, rootMatch: SQL) {
  return sql<boolean>`(${scopeType} is distinct from 'task_tree' or exists (
    select 1 from ${issues} where ${rootMatch} and ${readable} and ${issues.harnessKind} is null
  ))`;
}

/** Retained activity keeps its root privacy boundary after policy deletion. */
export function readableTaskTreeBudgetActivityCondition(readable: SQL<boolean>) {
  return readableTaskTreeBudgetCondition(readable, sql`${activityLog.details}->>'scopeType'`, sql`
    ${issues.companyId} = ${activityLog.companyId} and ${issues.id}::text = ${activityLog.details}->>'scopeId'
  `);
}

/** Existing receipts may contain identifiers that their task audiences cannot read. */
export function redactBudgetReceiptActivity<Row extends { action: string; details: Record<string, unknown> | null }>(row: Row): Row {
  if (!row.details) return row;
  if (row.action === "budget.cancelled_work_continued" || row.action === "budget.cancelled_work_not_continued") {
    const { budgetIncidentId: _budgetIncidentId, ...details } = row.details;
    return { ...row, details };
  }
  if (row.action === "budget.cancelled_work_resume_requested" && row.details.scopeType === "task_tree") {
    const { sampleRunIds: _sampleRunIds, ...details } = row.details;
    return { ...row, details };
  }
  return row;
}
