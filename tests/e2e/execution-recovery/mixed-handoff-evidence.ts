type Role = "lead" | "builder" | "verifier";

export interface MixedHandoffRun {
  id: string;
  agentId: string;
  issueId: string;
  runtimeMode: "legacy" | "native";
  status: string;
  incomingHandoffId: string;
  handoffVersion: number;
  releasedIssueId: string | null;
}

export interface MixedHandoffObservation {
  task: { id: string; status: string; assigneeAgentId: string | null };
  caseRecord: { workIssueId: string; handoffVersion: number };
  agents: Record<Role, string>;
  handoffs: Array<{
    id: string;
    issueId: string;
    version: number;
    state: string;
    sourceRunId: string | null;
    toAgentId: string;
  }>;
  runs: MixedHandoffRun[];
  artifact: { issueId: string; revisionId: string; body: string } | null;
  verification: { runId: string; artifactRevisionId: string } | null;
}

/** Score the observed effects of the fixed lead → builder → verifier journey. */
export function gradeMixedHandoff(observed: MixedHandoffObservation, expectedArtifact: string) {
  const { task, caseRecord, agents, artifact, verification } = observed;
  const roles = ["lead", "builder", "verifier"] as const;
  const handoffs = [...observed.handoffs].sort((left, right) => left.version - right.version);
  const runsByRole = roles.map(role => observed.runs.filter(run => run.agentId === agents[role]));
  const [lead, builder, verifier] = runsByRole.map(([run]) => run);
  const delivered = roles.every((role, index) => {
    const handoff = handoffs[index];
    const run = runsByRole[index]?.[0];
    const previousRun = runsByRole[index - 1]?.[0];
    return handoff?.version === index + 1 && handoff.state === "delivered" && handoff.issueId === task.id
      && handoff.toAgentId === agents[role] && handoff.sourceRunId === (previousRun?.id ?? null)
      && run?.incomingHandoffId === handoff.id && run.handoffVersion === handoff.version;
  });
  return {
    originalTaskCompleted: Boolean(task.id) && caseRecord.workIssueId === task.id && task.status === "done"
      && task.assigneeAgentId === agents.verifier,
    singleClaimPerRole: observed.runs.length === roles.length && new Set(roles.map(role => agents[role])).size === roles.length
      && runsByRole.every(runs => runs.length === 1 && runs[0]!.issueId === task.id && runs[0]!.status === "succeeded")
      && new Set(observed.runs.map(run => run.id)).size === roles.length,
    mixedRuntime: lead?.runtimeMode === "legacy" && builder?.runtimeMode === "native" && verifier?.runtimeMode === "legacy",
    outgoingRelease: lead?.releasedIssueId === task.id && builder?.releasedIssueId === task.id,
    contextRevisions: handoffs.length === roles.length && caseRecord.handoffVersion === roles.length && delivered,
    independentlyVerifiedArtifact: artifact?.issueId === task.id && Boolean(artifact.revisionId)
      && artifact.body === expectedArtifact && Boolean(verifier?.id) && verification?.runId === verifier?.id
      && verification?.artifactRevisionId === artifact.revisionId,
  };
}
