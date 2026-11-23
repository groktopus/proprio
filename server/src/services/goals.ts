import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@groktopus/db";
import { goals } from "@groktopus/db";
import { updateGoalSchema, type UpdateGoal } from "@groktopus/shared";
import { unprocessable } from "../errors.js";

type GoalReader = Pick<Db, "select">;

async function assertParentCompany(
  db: GoalReader,
  companyId: string,
  parentId: string | null | undefined,
) {
  if (!parentId) return;
  const [parent] = await db.select({ id: goals.id }).from(goals)
    .where(and(eq(goals.id, parentId), eq(goals.companyId, companyId))).for("key share");
  if (!parent) throw unprocessable("Parent goal not found in this company");
}

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db.transaction(async (tx) => {
        await assertParentCompany(tx, companyId, data.parentId);
        return tx
          .insert(goals)
          .values({ ...data, companyId })
          .returning()
          .then((rows) => rows[0]);
      }),

    update: (id: string, data: UpdateGoal) =>
      db.transaction(async (tx) => {
        const [existing] = await tx.select({ companyId: goals.companyId }).from(goals)
          .where(eq(goals.id, id));
        if (!existing) return null;
        const parsed = updateGoalSchema.safeParse(data);
        if (!parsed.success) {
          throw unprocessable("Invalid goal update", parsed.error.issues);
        }
        const requestedCompanyId = (data as Record<string, unknown>).companyId;
        if (requestedCompanyId !== undefined && requestedCompanyId !== existing.companyId) {
          throw unprocessable("Goal company cannot be changed");
        }
        const patch = parsed.data;
        const inCompany = and(eq(goals.id, id), eq(goals.companyId, existing.companyId));
        if (patch.parentId !== undefined) {
          // Serialize parent changes before taking goal row locks. A competing
          // move must see the first move's committed ancestry.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`proprio:goal-tree:${existing.companyId}`}, 0))`);
        }
        const [locked] = await tx.select({ id: goals.id }).from(goals)
          .where(inCompany).for("no key update");
        if (!locked) return null;

        await assertParentCompany(tx, existing.companyId, patch.parentId);
        if (patch.parentId) {
          // UNION stops traversal even if an older client saved a cycle.
          const [ancestry] = await tx.execute<{ contains_goal: boolean; reaches_root: boolean }>(sql`
            with recursive ancestors(id, parent_id) as (
              select id, parent_id from ${goals}
              where company_id = ${existing.companyId} and id = ${patch.parentId}
              union
              select parent.id, parent.parent_id from ${goals} parent
              join ancestors on ancestors.parent_id = parent.id
              where parent.company_id = ${existing.companyId}
            )
            select bool_or(id = ${id}) as contains_goal, bool_or(parent_id is null) as reaches_root
            from ancestors
          `);
          if (ancestry.contains_goal) {
            throw unprocessable("A goal cannot be moved under itself or one of its descendants");
          }
          if (!ancestry.reaches_root) {
            throw unprocessable("Repair the proposed parent's goal hierarchy before moving this goal");
          }
        }
        return tx
          .update(goals)
          .set({ ...patch, updatedAt: new Date() })
          .where(inCompany)
          .returning()
          .then((rows) => rows[0] ?? null);
      }),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
