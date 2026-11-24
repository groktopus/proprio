import type { DependencyDiagnosis } from "@groktopus/shared";

export function dependencyDiagnosisForViewer(
  diagnosis: DependencyDiagnosis,
  readableIssueIds: ReadonlySet<string>,
  mayInvestigate: boolean,
): DependencyDiagnosis {
  const firstRestricted = diagnosis.dependencyPath.findIndex(({ issueId }) => !readableIssueIds.has(issueId));
  const causeIsRestricted = diagnosis.cause.issueId !== null && !readableIssueIds.has(diagnosis.cause.issueId);
  const canInvestigate = mayInvestigate && diagnosis.canInvestigate;
  if (firstRestricted < 0 && !causeIsRestricted) return { ...diagnosis, canInvestigate };

  return {
    state: diagnosis.state,
    dependencyPath: firstRestricted < 0 ? diagnosis.dependencyPath : diagnosis.dependencyPath.slice(0, firstRestricted),
    cause: { kind: "restricted_dependency", issueId: null },
    nextOwner: { type: diagnosis.nextOwner.type },
    nextAction: canInvestigate
      ? "Ask the task assignee to investigate the restricted dependency."
      : "Ask a board member with access to check the dependency.",
    wake: diagnosis.wake,
    canInvestigate,
  };
}
