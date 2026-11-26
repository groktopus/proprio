import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { activityLog, issues, type Db } from "@groktopus/db";
import type { AuthorizationActor } from "./authorization.js";
import { issueReadSqlCondition } from "./authorization.js";
import { withAuthorizationReadSnapshot } from "./authorization-read-scope.js";
import { visibleIssueCondition } from "./issue-visibility.js";

export function budgetTaskTreeRootReadCondition(db: Db, actor: AuthorizationActor) {
  return withAuthorizationReadSnapshot(() => issueReadSqlCondition(db, actor));
}

export async function canReadBudgetTaskTreeRoot(db: Db, companyId: string, rootIssueId: string, actor: AuthorizationActor) {
  const readable = await budgetTaskTreeRootReadCondition(db, actor);
  const [root] = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId), readable, visibleIssueCondition())).limit(1);
  return Boolean(root);
}

/** Task-tree budgets inherit the root task's privacy boundary. */
export function readableTaskTreeBudgetCondition(readable: SQL<boolean>, scopeType: SQLWrapper, rootMatch: SQL) {
  return sql<boolean>`(${scopeType} is distinct from 'task_tree' or exists (
    select 1 from ${issues} where ${rootMatch} and ${readable} and ${visibleIssueCondition()}
  ))`;
}

/** Retained activity keeps its root privacy boundary after policy deletion. */
export function readableTaskTreeBudgetActivityCondition(readable: SQL<boolean>) {
  return readableTaskTreeBudgetCondition(readable, sql`${activityLog.details}->>'scopeType'`, sql`
    ${issues.companyId} = ${activityLog.companyId} and ${issues.id}::text = ${activityLog.details}->>'scopeId'
  `);
}
