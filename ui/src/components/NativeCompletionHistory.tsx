import type { NativeCompletionHistoryEntry, NativeCompletionEvidenceReference } from "@groktopus/shared";
import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { activityApi } from "@/api/activity";
import { queryKeys } from "@/lib/queryKeys";

function label(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function Status({ children }: { children: ReactNode }) {
  return <span className="inline-flex rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">{children}</span>;
}

function EvidenceReference({ evidence }: { evidence: NativeCompletionEvidenceReference }) {
  return (
    <li className="space-y-1">
      <p className="text-sm">{evidence.label}</p>
      <div className="flex flex-wrap gap-2">
        <Status>Evidence {label(evidence.outcome)}</Status>
        <Status>Visibility {label(evidence.visibility)}</Status>
      </div>
    </li>
  );
}

function Criterion({ entry, criterion }: {
  entry: NativeCompletionHistoryEntry;
  criterion: NonNullable<NativeCompletionHistoryEntry["contract"]>["criteria"][number];
}) {
  const assessment = entry.assessment?.criterionAssessments.find(item => item.criterionId === criterion.id);
  return (
    <li className="space-y-2">
      <p className="font-medium text-foreground">{criterion.requirement}</p>
      <div className="flex flex-wrap gap-2">
        <Status>Agent claim {label(assessment?.claimStatus)}</Status>
        <Status>Policy assessment {label(assessment?.outcome)}</Status>
      </div>
      {assessment?.evidence.length ? (
        <ul className="space-y-2 pl-3">
          {assessment.evidence.map((evidence, index) => <EvidenceReference key={`${evidence.kind}-${index}`} evidence={evidence} />)}
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
      {check.detail ? <p className="text-sm text-muted-foreground">{check.detail}</p> : null}
      {check.evidence ? <ul><EvidenceReference evidence={check.evidence} /></ul> : <p className="text-sm text-muted-foreground">No verification evidence reference recorded.</p>}
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
  return (
    <article id={anchor} tabIndex={-1} className="space-y-4 border-b border-border pb-4 last:border-b-0 last:pb-0">
      <header className="space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-medium text-foreground">Native completion assessment</h3>
          <time className="text-xs text-muted-foreground" dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time>
        </div>
        {entry.result?.summary ? <p className="text-sm text-muted-foreground">{entry.result.summary}</p> : null}
      </header>

      {entry.contract ? (
        <section aria-label="Completion policy" className="space-y-2">
          <h4 className="text-sm font-medium">Completion policy</h4>
          <p className="text-sm text-muted-foreground">
            Policy {entry.contract.policyVersion} · {label(entry.contract.risk)} risk · authority {label(entry.contract.completionAuthority)} · incomplete requirements {label(entry.contract.incompleteCriteriaPolicy)}
          </p>
          {entry.contract.supersedesContractId ? <p className="text-sm text-muted-foreground">This policy replaces an earlier requirement set.</p> : null}
          {criteria.length ? (
            <ul className="space-y-3">
              {criteria.map(criterion => <Criterion key={criterion.id} entry={entry} criterion={criterion} />)}
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
            <Status>Evidence verification {assessment.verificationPassed === true ? "passed" : assessment.verificationPassed === false ? "failed" : "not recorded"}</Status>
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
          {entry.decision.appliedAt ? <p className="text-sm text-muted-foreground">Applied {new Date(entry.decision.appliedAt).toLocaleString()}</p> : null}
          {priorAnchor ? <a href={`#${priorAnchor}`} className="text-sm text-primary underline underline-offset-2">
            Open earlier decision and evidence
          </a> : <>
            {entry.decision.supersedesDecisionId ? <p className="text-sm text-muted-foreground">Supersedes an earlier status decision.</p> : null}
            {assessment?.supersedesAssessmentId || assessment?.priorDecisionId ? <p className="text-sm text-muted-foreground">This assessment supersedes an earlier assessment or decision.</p> : null}
          </>}
        </section>
      ) : <p className="text-sm text-muted-foreground">No status decision is linked to this assessment.</p>}

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
      {entries?.length ? <div className="space-y-4">{entries.map(entry => {
        const priorDecisionId = entry.decision?.supersedesDecisionId ?? entry.assessment?.priorDecisionId;
        const priorAssessmentId = entry.assessment?.supersedesAssessmentId;
        const prior = entries.find(candidate => candidate.id !== entry.id && (
          (priorDecisionId && candidate.decision?.id === priorDecisionId)
          || (priorAssessmentId && candidate.assessment?.id === priorAssessmentId)
        ));
        return <CompletionEntry key={entry.id} entry={entry} anchor={`${historyId}-${entry.id}`}
          priorAnchor={prior && `${historyId}-${prior.id}`} />;
      })}</div> : null}
    </section>
  );
}


export function TaskCompletionHistoryDisclosure({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  const history = useQuery({
    queryKey: queryKeys.issues.completionHistory(issueId),
    queryFn: () => activityApi.completionHistoryForIssue(issueId),
    enabled: open,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer rounded-sm text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Completion history
      </summary>
      {open && <NativeCompletionHistory
        entries={history.data}
        isLoading={history.isLoading}
        error={history.isError}
        onRetry={() => { void history.refetch(); }}
        showHeading={false}
      />}
    </details>
  );
}
