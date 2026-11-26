import { and, eq, sql, type SQL } from "drizzle-orm";
import { activityLog, budgetPolicies, issues, type Db } from "@groktopus/db";
import type { AuthorizationActor } from "./authorization.js";
import { issueReadSqlCondition } from "./authorization.js";
import { withAuthorizationReadSnapshot } from "./authorization-read-scope.js";
import { visibleIssueCondition } from "./issue-visibility.js";

/** Task-tree budgets inherit the root task's privacy boundary. */
export async function visibleBudgetTaskTreeScopeIds(db: Db, companyId: string, actor: AuthorizationActor): Promise<string[]> {
  const readable = await withAuthorizationReadSnapshot(() => issueReadSqlCondition(db, actor));
  const rows = await db.selectDistinct({ scopeId: budgetPolicies.scopeId }).from(budgetPolicies)
    .innerJoin(issues, and(eq(issues.id, budgetPolicies.scopeId), eq(issues.companyId, budgetPolicies.companyId)))
    .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "task_tree"), readable, visibleIssueCondition()));
  return rows.map(row => row.scopeId);
}

export async function canReadBudgetTaskTreeRoot(db: Db, companyId: string, rootIssueId: string, actor: AuthorizationActor) {
  const readable = await withAuthorizationReadSnapshot(() => issueReadSqlCondition(db, actor));
  const [root] = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId), readable, visibleIssueCondition())).limit(1);
  return Boolean(root);
}

/** Apply the task reader at the activity statement, including retained activity without a policy row. */
export function readableTaskTreeBudgetActivityCondition(readable: SQL<boolean>) {
  return sql<boolean>`(${activityLog.details}->>'scopeType' is distinct from 'task_tree' or exists (
    select 1 from ${issues}
    where ${issues.companyId} = ${activityLog.companyId}
      and ${issues.id}::text = ${activityLog.details}->>'scopeId'
      and ${readable} and ${visibleIssueCondition()}
  ))`;
}
