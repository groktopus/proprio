import type { Issue, IssueExecutionReviewEvidence, IssueExecutionReviewTargetReference, IssueThreadInteraction } from "@groktopus/shared";

interface ExecutionReviewEvidenceProps {
  issue: Issue;
  evidence?: IssueExecutionReviewEvidence;
  interactions?: IssueThreadInteraction[];
}

type ReviewTarget = IssueExecutionReviewTargetReference | null;
type ReviewPayload = { qualityReview?: { key?: string; requirementHash?: string }; target?: ReviewTarget; items?: Array<{ qualityReview?: { key?: string; requirementHash?: string }; target?: ReviewTarget }> };

function targetLabel(target: ReviewTarget): string {
  if (!target) return "No exact artifact attached";
  return target.type === "issue_document"
    ? `Document ${target.key} · revision ${target.revisionId}`
    : `Attachment ${target.attachmentId} · asset ${target.assetId} · SHA-256 ${target.sha256}`;
}

function interactionForKey(interactions: IssueThreadInteraction[], key: string) {
  for (let index = interactions.length - 1; index >= 0; index -= 1) {
    const interaction = interactions[index]!;
    const payload = interaction.payload as ReviewPayload;
    if (interaction.kind === "request_confirmation" && payload.qualityReview?.key === key) {
      return { interaction, target: payload.target ?? null, requirementHash: payload.qualityReview.requirementHash };
    }
    if (interaction.kind === "request_item_verdicts") {
      const matching = payload.items?.filter((item) => item.qualityReview?.key === key) ?? [];
      if (matching.length === 1) return { interaction, target: matching[0].target ?? null,
        requirementHash: matching[0].qualityReview?.requirementHash };
    }
  }
  return null;
}

export function ExecutionReviewEvidence({ issue, evidence, interactions = [] }: ExecutionReviewEvidenceProps) {
  const requirement = issue.executionPolicy?.reviewTargetBinding?.source === "required_quality_review"
    ? issue.executionPolicy.requiredQualityReview : null;
  const history = evidence?.executionDecisions ?? [];
  if (!requirement && !history.some(decision => decision.reviewTargetBinding)) return null;

  const staleByKey = new Map((evidence?.requiredQualityReviewState?.missing ?? [])
    .filter((entry) => entry.reason === "stale")
    .map((entry) => [entry.key, entry]));

  return (
    <section className="space-y-2" aria-label="Required output review">
      <h3 className="text-sm font-medium">Required output review</h3>
      {requirement ? <ul className="space-y-2">
        {requirement.deliverables.map((deliverable) => {
          const current = interactionForKey(interactions, deliverable.key);
          const stale = staleByKey.get(deliverable.key);
          return (
            <li key={deliverable.key} className="space-y-1 text-sm">
              <div className="font-medium">{deliverable.label}</div>
              <div className="break-all font-mono text-xs text-muted-foreground">{targetLabel(current?.target ?? null)}</div>
              {current?.requirementHash ? <div className="break-all font-mono text-xs text-muted-foreground">
                Requirements SHA-256 {current.requirementHash}
              </div> : null}
              {stale && current ? (
                <a className="text-sm text-primary underline underline-offset-2" href={`/issues/${issue.identifier ?? issue.id}#interaction-${current.interaction.id}`}>
                  Open the changed artifact’s review request
                </a>
              ) : stale ? (
                <p className="text-sm text-destructive">Request a fresh review of the changed artifact from the task conversation.</p>
              ) : current ? (
                <a className="text-sm text-primary underline underline-offset-2" href={`/issues/${issue.identifier ?? issue.id}#interaction-${current.interaction.id}`}>
                  Open review request
                </a>
              ) : (
                <p className="text-sm text-muted-foreground">Waiting for an exact artifact and human review.</p>
              )}
            </li>
          );
        })}
      </ul> : null}
      {history.length > 0 && (
        <details className="pt-1">
          <summary className="cursor-pointer text-sm text-muted-foreground">Decision history ({history.length})</summary>
          <ul className="mt-2 space-y-2">
            {history.map((decision) => (
              <li key={decision.id} className="text-sm">
                <div>{decision.stageType === "review" ? "Review" : "Approval"} {decision.outcome}</div>
                {decision.reviewTargetBinding?.deliverables.map((item) => (
                  <div key={`${decision.id}:${item.key}`} className="break-all font-mono text-xs text-muted-foreground">
                    {item.label} · {targetLabel(item.target)}
                  </div>
                ))}
                {decision.reviewTargetBinding ? <div className="break-all font-mono text-xs text-muted-foreground">
                  Requirements SHA-256 {decision.reviewTargetBinding.requirementHash}
                </div> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
