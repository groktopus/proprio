import { and, eq, sql } from "drizzle-orm";
import { isUuidLike } from "@groktopus/shared";
import { companies, heartbeatRuns, projects, type Db } from "@groktopus/db";
import { notFound } from "../errors.js";
import { loadAncestorIssueIds } from "./issue-hierarchy.js";
import { loadRunBoundIssue, runBoundIssueReference } from "./issue-creation-source.js";

type BudgetLineageRun = Pick<typeof heartbeatRuns.$inferSelect,
  "companyId" | "issueId" | "nativeIssueId" | "contextSnapshot" | "taskLineageJson">;

/** Resolve a run's recorded billing tree or the current ancestry before its first admission. */
export async function resolveRunTaskTreeLineage(db: Db, run: BudgetLineageRun, fallbackIssueId?: string | null) {
  if (run.taskLineageJson?.version === 1 && Array.isArray(run.taskLineageJson.pathIssueIds)) {
    return run.taskLineageJson.pathIssueIds;
  }
  const reference = runBoundIssueReference(run);
  const issueId = reference && !isUuidLike(reference) ? (await loadRunBoundIssue(db, run))?.id
    : reference ?? (fallbackIssueId && isUuidLike(fallbackIssueId) ? fallbackIssueId : null);
  return loadAncestorIssueIds(db, run.companyId, issueId);
}

/** Shared execution-authority fences allow concurrent admissions. Acquire
 * before feature/agent/run locks; they exclude manual pause/delete until this
 * admission commits. Settlements and eligibility-only reads never call this. */
export async function lockBudgetAdmissionControls(tx: Db, companyId: string, projectId?: string | null) {
  const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("share");
  if (!company) throw notFound("Company not found");
  if (projectId) {
    const [project] = await tx.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId))).for("share");
    if (!project) throw notFound("Budget project not found");
  }
}

/** An admission's set of active tree policies stays stable until it commits.
 * Shared readers keep unrelated admissions concurrent. Capacity is fenced
 * independently per active root; policy writes take this gate exclusively. */
export async function lockTaskTreeBudgetConfiguration(tx: Db, companyId: string, mode: "shared" | "exclusive") {
  const lock = mode === "shared" ? sql`pg_advisory_xact_lock_shared` : sql`pg_advisory_xact_lock`;
  await tx.execute(sql`select ${lock}(hashtextextended(${`task-tree-budget-configuration:${companyId}`}, 0))`);
}
