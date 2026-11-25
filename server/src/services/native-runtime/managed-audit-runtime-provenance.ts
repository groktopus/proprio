import { and, inArray, eq } from "drizzle-orm";
import { companySkillVersions, companySkills, type Db } from "@groktopus/db";
import type { ToolRunRuntimeProvenance } from "@groktopus/shared";
import { parseNativeExecutionInput } from "../../vendor/proprio-runner/index.js";
import { skillAccessService } from "../skill-access.js";
import type { AuthorizationActor } from "../authorization.js";

const unknown: ToolRunRuntimeProvenance = { source: "unknown" };

/** Project only validated native admission fields and skills readable by this actor. */
export async function managedAuditRuntimeProvenance(db: Db, actor: AuthorizationActor, run: {
  id: string; companyId: string; agentId: string; issueId: string | null; runtimeMode: string | null;
  driverKind: string | null; driverVersion: string | null; runnerProfileJson: Record<string, unknown> | null;
}): Promise<ToolRunRuntimeProvenance> {
  if (run.runtimeMode !== "native") return unknown;
  try {
    const input = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput);
    if (input.binding.runId !== run.id || input.binding.companyId !== run.companyId
      || input.binding.agentId !== run.agentId || input.binding.issueId !== run.issueId
      || !("runtimeContext" in input)) return unknown;
    const context = input.runtimeContext;
    const ids = [...new Set(context.skills.flatMap(skill => skill.versionId ? [skill.versionId] : []))];
    const visible = new Map<string, { key: string; versionId: string; bundleDigest: string }>();
    if (ids.length) {
      const condition = await skillAccessService(db, actor).condition(run.companyId);
      const rows = await db.select({ versionId: companySkillVersions.id, key: companySkills.key,
        skillId: companySkills.id }).from(companySkillVersions).innerJoin(companySkills,
        eq(companySkillVersions.companySkillId, companySkills.id)).where(and(
        eq(companySkillVersions.companyId, run.companyId), eq(companySkills.companyId, run.companyId),
        inArray(companySkillVersions.id, ids), condition));
      for (const row of rows) {
        const admitted = context.skills.find(skill => skill.versionId === row.versionId && skill.key === row.key);
        if (admitted && /^[a-f0-9]{64}$/.test(admitted.bundle.digest)) visible.set(row.versionId,
          { key: row.key, versionId: row.versionId, bundleDigest: admitted.bundle.digest });
      }
    }
    return {
      source: "native_admission", provider: input.provider.kind,
      model: input.provider.model ?? null, driverKind: run.driverKind ?? "unknown",
      driverVersion: run.driverVersion ?? "unknown",
      runtimeContextDigest: /^[a-f0-9]{64}$/.test(context.aggregateDigest) ? context.aggregateDigest : null,
      mcpAssignmentDigest: context.mcp && /^[a-f0-9]{64}$/.test(context.mcp.digest) ? context.mcp.digest : null,
      skills: context.skills.flatMap(skill => skill.versionId && visible.has(skill.versionId)
        ? [visible.get(skill.versionId)!] : []),
    };
  } catch {
    return unknown;
  }
}
