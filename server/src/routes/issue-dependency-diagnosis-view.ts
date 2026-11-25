import type { DependencyDiagnosis } from "@groktopus/shared";
import type { ParentDependencyDiagnosis } from "../services/recovery/parent-dependency-diagnosis.js";

export function dependencyDiagnosisForViewer(
  diagnosis: ParentDependencyDiagnosis,
  readableIssueIds: ReadonlySet<string>,
  mayInvestigate: boolean,
): DependencyDiagnosis {
  const firstRestricted = diagnosis.dependencyPath.findIndex(({ issueId }) => !readableIssueIds.has(issueId));
  const causeIsRestricted = diagnosis.cause.issueId !== null && !readableIssueIds.has(diagnosis.cause.issueId);
  const restricted = firstRestricted >= 0 || causeIsRestricted;
  const canInvestigate = !restricted && mayInvestigate && diagnosis.canInvestigate;
  return {
    state: restricted ? "restricted" : diagnosis.state,
    dependencyPath: firstRestricted < 0 ? diagnosis.dependencyPath : diagnosis.dependencyPath.slice(0, firstRestricted),
    cause: restricted ? { kind: "restricted_dependency", issueId: null }
      : { kind: diagnosis.cause.kind, issueId: diagnosis.cause.issueId },
    nextOwner: restricted ? { type: "board" } : { type: diagnosis.nextOwner.type, name: diagnosis.nextOwner.name },
    nextAction: restricted ? "Ask a board member with access to check the dependency." : diagnosis.nextAction,
    wake: { status: diagnosis.wake.status, ...(canInvestigate ? { idempotencyKey: diagnosis.wake.idempotencyKey } : {}) },
    canInvestigate,
  };
}
