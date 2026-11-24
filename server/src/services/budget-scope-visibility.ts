import { and, eq, inArray, or, sql } from "drizzle-orm";
import { activityLog, budgetPolicies, issues, type Db } from "@groktopus/db";
import type { AuthorizationActor } from "./authorization.js";
import { issueReadSqlCondition } from "./authorization.js";
import { visibleIssueCondition } from "./issue-visibility.js";

/** Task-tree budgets inherit the root task's privacy boundary. */
export async function visibleBudgetTaskTreeScopeIds(db: Db, companyId: string, actor: AuthorizationActor): Promise<string[]> {
  const readable = await issueReadSqlCondition(db, actor);
  const rows = await db.selectDistinct({ scopeId: budgetPolicies.scopeId }).from(budgetPolicies)
    .innerJoin(issues, and(eq(issues.id, budgetPolicies.scopeId), eq(issues.companyId, budgetPolicies.companyId)))
    .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeType, "task_tree"), readable, visibleIssueCondition()));
  return rows.map(row => row.scopeId);
}

export async function canReadBudgetTaskTreeRoot(db: Db, companyId: string, rootIssueId: string, actor: AuthorizationActor) {
  const readable = await issueReadSqlCondition(db, actor);
  const [root] = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, rootIssueId), readable, visibleIssueCondition())).limit(1);
  return Boolean(root);
}

/** Activity rows do not store a typed scope reference; this predicate stays
 * safe for legacy or malformed details by comparing text IDs, without casts. */
export function readableTaskTreeBudgetActivityCondition(visibleScopeIds: readonly string[]) {
  return or(sql`${activityLog.details}->>'scopeType' is distinct from 'task_tree'`,
    visibleScopeIds.length ? inArray(sql`${activityLog.details}->>'scopeId'`, [...visibleScopeIds]) : sql`false`)!;
}
