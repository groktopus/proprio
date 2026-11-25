import type { NativeCompletionCriterionAssessment, NativeCompletionHistoryEntry, NativeCompletionEvidenceReference } from "@groktopus/shared";
import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "@/api/activity";
import { useQueryView } from "@/components/QueryView";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { queryKeys } from "@/lib/queryKeys";
import { cn, formatDateTime } from "@/lib/utils";

function label(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function Status({ children }: { children: ReactNode }) {
  return <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{children}</span>;
}

function EvidenceReference({ evidence }: { evidence: NativeCompletionEvidenceReference }) {
  return (
    <div className="space-y-1">
      <p className="text-sm">{evidence.label}</p>
      <div className="flex flex-wrap gap-2">
        <Status>Evidence {label(evidence.outcome)}</Status>
        <Status>Visibility {label(evidence.visibility)}</Status>
      </div>
    </div>
  );
}

function Criterion({ criterion, assessment }: {
  criterion: NonNullable<NativeCompletionHistoryEntry["contract"]>["criteria"][number];
  assessment: NativeCompletionCriterionAssessment | undefined;
}) {
  return (
    <li className="space-y-2">
      <p className="font-medium text-foreground">{criterion.requirement}</p>
      <div className="flex flex-wrap gap-2">
        <Status>Agent claim {label(assessment?.claimStatus)}</Status>
        <Status>Policy assessment {label(assessment?.outcome)}</Status>
      </div>
      {assessment?.evidence.length ? (
        <ul className="space-y-2 pl-3">
          {assessment.evidence.map((evidence, index) => (
            <li key={`${evidence.kind}-${index}`}><EvidenceReference evidence={evidence} /></li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted-foreground">No evidence reference recorded for this requirement.</p>}
    </li>
  );
}

function Verification({ check }: {
  check: NonNullable<NativeCompletionHistoryEntry["assessment"]>["verificationAssessments"][number];
}) {
  return (
    <li className="space-y-1">
      <p className="font-medium text-foreground">{check.commandOrCheck}</p>
      <div className="flex flex-wrap gap-2">
        <Status>Check claim {label(check.claimStatus)}</Status>
        <Status>Evidence assessment {label(check.outcome)}</Status>
      </div>
      {check.reportedReasonCode ? <p className="text-sm text-muted-foreground">Reported reason {label(check.reportedReasonCode)}</p> : null}
      {check.detail ? <p className="text-sm text-muted-foreground">{check.detail}</p> : null}
      {check.evidence ? <EvidenceReference evidence={check.evidence} /> : <p className="text-sm text-muted-foreground">No verification evidence reference recorded.</p>}
    </li>
  );
}

function CompletionEntry({ entry, anchor, priorAnchor }: {
  entry: NativeCompletionHistoryEntry;
  anchor: string;
  priorAnchor?: string;
}) {
  const criteria = entry.contract?.criteria ?? [];
  const assessment = entry.assessment;
  const assessmentsByCriterion = new Map<string, NativeCompletionCriterionAssessment>();
  for (const item of assessment?.criterionAssessments ?? []) {
    const { criterionId } = item;
    if (!assessmentsByCriterion.has(criterionId)) assessmentsByCriterion.set(criterionId, item);
  }
  return (
    <article id={anchor} tabIndex={-1} className="space-y-4 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium text-foreground">{assessment?.triggerKind === "native_attention" ? "Native attention assessment" : "Native completion assessment"}</h3>
          <time className="font-mono text-xs text-muted-foreground" dateTime={entry.createdAt}>{formatDateTime(entry.createdAt)}</time>
        </div>
        {entry.result?.summary ? <p className="text-sm text-muted-foreground">{entry.result.summary}</p> : null}
      </header>

      {entry.contract ? (
        <section aria-label="Completion policy" className="space-y-2">
          <h4 className="text-sm font-medium">Completion policy</h4>
          <p className="text-sm text-muted-foreground">
            Requirements revision {entry.contract.revision} · Policy {entry.contract.policyVersion} · {label(entry.contract.risk)} risk · authority {label(entry.contract.completionAuthority)} · incomplete requirements {label(entry.contract.incompleteCriteriaPolicy)}
          </p>
          {entry.contract.supersedesContractId ? <p className="text-sm text-muted-foreground">This policy replaces an earlier requirement set.</p> : null}
          {criteria.length ? (
            <ul className="space-y-3">
              {criteria.map(criterion => (
                <Criterion key={criterion.id} criterion={criterion} assessment={assessmentsByCriterion.get(criterion.id)} />
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No completion requirements were recorded.</p>}
        </section>
      ) : <p className="text-sm text-muted-foreground">Completion policy is missing from this history entry.</p>}

      {assessment ? (
        <section aria-label="Assessment and verification" className="space-y-2">
          <h4 className="text-sm font-medium">Assessment and verification</h4>
          <p className="text-sm text-muted-foreground">
            Assessor policy {assessment.policyVersion} · {label(assessment.triggerKind)}
          </p>
          <div className="flex flex-wrap gap-2">
            <Status>Policy assessment {assessment.allCriteriaSatisfied === true ? "all requirements satisfied" : assessment.allCriteriaSatisfied === false ? "requirements not all satisfied" : "not recorded"}</Status>
            <Status>{assessment.verificationPassed === true ? "Evidence verified" : assessment.verificationPassed === false ? "Evidence not verified" : "Evidence verification not recorded"}</Status>
          </div>
          {assessment.summary ? <p className="text-sm text-muted-foreground">{assessment.summary}</p> : null}
          {assessment.verificationAssessments.length ? (
            <ul className="space-y-3">
              {assessment.verificationAssessments.map((check, index) => <Verification key={`${check.commandOrCheck}-${index}`} check={check} />)}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No verification checks were recorded. Policy acceptance alone does not show that evidence was verified.</p>}
        </section>
      ) : <p className="text-sm text-muted-foreground">Assessment details are missing from this history entry.</p>}

      {entry.result ? (
        <section aria-label="Reported completion result" className="space-y-1">
          <h4 className="text-sm font-medium">Reported completion result</h4>
          <div className="flex flex-wrap gap-2">
            <Status>Disposition {label(entry.result.disposition)}</Status>
            <Status>Schema {label(entry.result.schemaStatus)}</Status>
          </div>
        </section>
      ) : <p className="text-sm text-muted-foreground">Completion result is missing from this history entry.</p>}

      {entry.decision ? (
        <section aria-label="Status decision" className="space-y-1">
          <h4 className="text-sm font-medium">Status decision</h4>
          <p className="text-sm text-muted-foreground">
            {label(entry.decision.applicationState)} · {label(entry.decision.fromStatus)} → {label(entry.decision.toStatus)} · {label(entry.decision.reasonCode)} · policy {entry.decision.policyVersion}
          </p>
          {entry.decision.statusAction ? <p className="text-sm text-muted-foreground">Action {label(entry.decision.statusAction)}</p> : null}
          {entry.decision.appliedAt ? <p className="text-sm text-muted-foreground">Applied <time dateTime={entry.decision.appliedAt} className="font-mono">{formatDateTime(entry.decision.appliedAt)}</time></p> : null}
        </section>
      ) : <p className="text-sm text-muted-foreground">No status decision is linked to this assessment.</p>}

      {priorAnchor ? (
        <a href={`#${priorAnchor}`} className="text-sm text-primary underline underline-offset-2">
          Open earlier decision and evidence
        </a>
      ) : (
        <>
          {entry.decision?.supersedesDecisionId ? <p className="text-sm text-muted-foreground">Supersedes an earlier status decision.</p> : null}
          {assessment?.supersedesAssessmentId || assessment?.priorDecisionId ? <p className="text-sm text-muted-foreground">This assessment supersedes an earlier assessment or decision.</p> : null}
        </>
      )}

      {entry.lineageGaps.length ? (
        <p className="text-sm text-muted-foreground">Incomplete history: missing {entry.lineageGaps.map(label).join(", ")} record{entry.lineageGaps.length === 1 ? "" : "s"}.</p>
      ) : null}
    </article>
  );
}

export function NativeCompletionHistory({ entries, isLoading, error, onRetry, showHeading = true }: {
  entries: NativeCompletionHistoryEntry[] | undefined;
  isLoading: boolean;
  error: boolean;
  onRetry: () => void;
  showHeading?: boolean;
}) {
  const historyId = useId();
  const decisionIndexes = new Map<string, number>();
  const assessmentIndexes = new Map<string, number>();
  entries?.forEach((entry, index) => {
    if (entry.decision) decisionIndexes.set(entry.decision.id, index);
    if (entry.assessment) assessmentIndexes.set(entry.assessment.id, index);
  });
  return (
    <section aria-label="Native completion history" className="mb-4 space-y-3">
      {showHeading && <h2 className="text-base font-medium text-foreground">Native completion history</h2>}
      {isLoading && !entries ? <p role="status" className="text-sm text-muted-foreground">Loading completion history…</p> : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>Completion history could not be loaded.</span>
          <button type="button" className="underline underline-offset-2" onClick={onRetry}>Retry</button>
        </div>
      ) : null}
      {!isLoading && !error && entries?.length === 0 ? <p className="text-sm text-muted-foreground">No native completion history recorded.</p> : null}
      {entries?.length ? (
        <div className={cn("min-w-0 space-y-4 wrap-anywhere", ANALYTICS_MASK_CLASS)}>
          {entries.map((entry, index) => {
            const priorDecisionId = entry.decision?.supersedesDecisionId ?? entry.assessment?.priorDecisionId;
            const priorAssessmentId = entry.assessment?.supersedesAssessmentId;
            const decisionIndex = priorDecisionId ? decisionIndexes.get(priorDecisionId) : undefined;
            const assessmentIndex = priorAssessmentId ? assessmentIndexes.get(priorAssessmentId) : undefined;
            const priorIndex = decisionIndex !== undefined && decisionIndex !== index ? decisionIndex : assessmentIndex;
            return (
              <CompletionEntry key={entry.id} entry={entry} anchor={`${historyId}-${index}`}
                priorAnchor={priorIndex !== undefined && priorIndex !== index ? `${historyId}-${priorIndex}` : undefined} />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}


export function TaskCompletionHistory({ issueId, showHeading }: { issueId: string; showHeading?: boolean }) {
  const history = useQuery({
    queryKey: queryKeys.issues.completionHistory(issueId),
    queryFn: () => activityApi.completionHistoryForIssue(issueId),
  });
  const view = useQueryView(history);
  const accessDenied = view.errorKind === "auth" || view.errorKind === "forbidden" || view.errorKind === "not_found";
  return (
    <NativeCompletionHistory
      entries={accessDenied ? undefined : view.data}
      isLoading={view.kind === "loading" || view.kind === "reconnecting"}
      error={view.kind === "error"}
      onRetry={view.retry}
      showHeading={showHeading}
    />
  );
}

export function TaskCompletionHistoryDisclosure({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Completion history
      </summary>
      {open && <TaskCompletionHistory issueId={issueId} showHeading={false} />}
    </details>
  );
}
