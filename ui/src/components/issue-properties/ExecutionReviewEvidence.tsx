import { useState } from "react";
import type { Issue, IssueExecutionReviewEvidence, IssueExecutionReviewTargetBinding, IssueExecutionReviewTargetReference } from "@groktopus/shared";
import { issuesApi } from "@/api/issues";
import { QueryErrorState } from "@/components/QueryView";
import { Button } from "@/components/ui/button";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { decisionReceiptHref } from "@/lib/decision-receipt-navigation";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useAuthorizedHistory } from "@/lib/use-authorized-history";

function targetLabel(target: IssueExecutionReviewTargetReference): string {
  return target.type === "issue_document"
    ? `Document ${target.key} · revision ${target.revisionId}`
    : `Attachment ${target.attachmentId} · asset ${target.assetId} · SHA-256 ${target.sha256}`;
}

function BindingDetails({ binding }: { binding: IssueExecutionReviewTargetBinding }) {
  return (
    <div className={`space-y-1 wrap-anywhere font-mono text-xs text-muted-foreground ${ANALYTICS_MASK_CLASS}`}>
      <ul className="space-y-1">
        {binding.deliverables.map(item => <li key={item.key}>{item.label} · {targetLabel(item.target)}</li>)}
      </ul>
      <p>Requirements SHA-256 {binding.requirementHash}</p>
    </div>
  );
}

interface ExecutionReviewEvidenceProps {
  issueHref: string;
  evidence: IssueExecutionReviewEvidence;
  historyExpanded?: boolean;
  historyOpen?: boolean;
  onHistoryToggle?: (open: boolean) => void;
  onNewerPage?: () => void;
  onOlderPage?: () => void;
}

export function ExecutionReviewEvidence({
  issueHref, evidence, historyExpanded = false, historyOpen, onHistoryToggle, onNewerPage, onOlderPage,
}: ExecutionReviewEvidenceProps) {
  const { currentRequests, executionDecisions, requiredQualityReviewState, submittedSignoff } = evidence;
  const requestsByKey = new Set(currentRequests.map(request => request.key));
  const missing = requiredQualityReviewState.missing.filter(entry => !requestsByKey.has(entry.key));
  const history = (
    <div className="space-y-2 pt-2">
      {executionDecisions.length === 0 ? <p className="text-sm text-muted-foreground">No bound signoff decisions recorded on this page.</p> : (
        <ul className="space-y-2">
          {executionDecisions.map(decision => (
            <li key={decision.id} className="space-y-1 text-sm">
              <div>{decision.stageType === "review" ? "Review" : "Approval"} {decision.outcome}</div>
              <BindingDetails binding={decision.reviewTargetBinding} />
            </li>
          ))}
        </ul>
      )}
      {(onNewerPage || onOlderPage) && <div className="flex flex-wrap gap-2">
        {onNewerPage && <Button variant="outline" size="sm" onClick={onNewerPage}>Newer decisions</Button>}
        {onOlderPage && <Button variant="outline" size="sm" onClick={onOlderPage}>Older decisions</Button>}
      </div>}
    </div>
  );

  return (
    <section className="space-y-2" aria-label="Required output review">
      {!historyExpanded && (
        <>
          <h3 className="text-sm font-medium">Required output review</h3>
          {submittedSignoff?.binding && <div className="space-y-1">
            <h4 className="text-sm font-medium">Submitted for signoff</h4>
            <BindingDetails binding={submittedSignoff.binding} />
          </div>}
          {submittedSignoff?.stale && <output className="block text-sm text-destructive">
            Request changes and submit the current outputs for a new review.
          </output>}
          {(currentRequests.length > 0 || missing.length > 0) && <ul className="space-y-2">
            {currentRequests.map(review => <li key={review.key} className="space-y-1 text-sm">
              <div className={`font-medium ${ANALYTICS_MASK_CLASS}`}>{review.label}</div>
              <div className={`wrap-anywhere font-mono text-xs text-muted-foreground ${ANALYTICS_MASK_CLASS}`}>
                <div>{targetLabel(review.target)}</div>
                <div>Requirements SHA-256 {review.requirementHash}</div>
              </div>
              <Link
                to={decisionReceiptHref({ issueHref, interactionId: review.interactionId })}
                disableIssueQuicklook
                className="text-sm text-primary underline underline-offset-2"
              >
                {review.outdated ? "Open previous review request" : "Open review request"}
              </Link>
            </li>)}
            {missing.map(entry => <li key={entry.key} className="text-sm">
              <span className={`font-medium ${ANALYTICS_MASK_CLASS}`}>{entry.label}</span>
              <p className="text-sm text-muted-foreground">Waiting for an exact artifact and human review.</p>
            </li>)}
          </ul>}
        </>
      )}
      {historyExpanded ? history : (executionDecisions.length > 0 || onNewerPage || onOlderPage) && (
        <details open={historyOpen} onToggle={event => onHistoryToggle?.(event.currentTarget.open)}>
          <summary className="cursor-pointer rounded-sm text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Signoff decision history
          </summary>
          {history}
        </details>
      )}
    </section>
  );
}

const noEvidence: IssueExecutionReviewEvidence = {
  executionDecisions: [],
  requiredQualityReviewState: { required: false, satisfied: true, missing: [] },
  submittedSignoff: null,
  currentRequests: [],
  nextCursor: null,
};

function TaskExecutionReviewEvidenceContent({ issue, historyExpanded }: { issue: Issue; historyExpanded?: boolean }) {
  const [previousCursors, setPreviousCursors] = useState<(string | null)[]>([]);
  const cursor = previousCursors.at(-1) ?? null;
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useAuthorizedHistory(queryKeys.issues.executionReviewEvidence(issue.id, cursor),
    signal => issuesApi.executionReviewEvidence(issue.id, cursor, signal), noEvidence);
  if (history.isLoading) return <output className="block text-sm text-muted-foreground">Loading signoff evidence…</output>;
  if (history.error) return <QueryErrorState size="inline" error={history.error} action="load signoff evidence" onRetry={history.onRetry} />;
  if (!history.data) return null;
  const { nextCursor } = history.data;
  return <ExecutionReviewEvidence
    issueHref={`/issues/${issue.identifier ?? issue.id}`}
    evidence={history.data}
    historyExpanded={historyExpanded}
    historyOpen={historyOpen}
    onHistoryToggle={setHistoryOpen}
    onNewerPage={previousCursors.length > 0 ? () => setPreviousCursors(cursors => cursors.slice(0, -1)) : undefined}
    onOlderPage={nextCursor ? () => setPreviousCursors(cursors => [...cursors, nextCursor]) : undefined}
  />;
}

export function TaskExecutionReviewEvidence({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false);
  const active = issue.executionPolicy?.reviewTargetBinding?.source === "required_quality_review";
  if (active) return <TaskExecutionReviewEvidenceContent issue={issue} />;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Signoff decision history
      </summary>
      {open && <TaskExecutionReviewEvidenceContent issue={issue} historyExpanded />}
    </details>
  );
}
