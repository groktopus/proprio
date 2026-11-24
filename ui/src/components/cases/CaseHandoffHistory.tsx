import { useQueryView } from "@/components/QueryView";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronRight } from "lucide-react";
import { Link } from "@/lib/router";
import { casesApi, type CaseHandoffView, type CaseWorkIssue } from "@/api/cases";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Identity } from "@/components/Identity";
import { MarkdownBody } from "@/components/MarkdownBody";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { Button } from "@/components/ui/button";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import type { CaseAgentMap } from "./CaseWorkSummary";

function HandoffActor({ id, name, fallback, agents }: {
  id: string | null;
  name: string | null | undefined;
  fallback: string;
  agents?: CaseAgentMap;
}) {
  return id ? <AgentIdentity agent={agents?.get(id) ?? { id, name: name ?? "Agent" }} size="xs" /> : <Identity name={name ?? fallback} size="xs" />;
}

export function CaseHandoffHistory({ caseId, task, agents }: { caseId: string; task?: CaseWorkIssue | null; agents?: CaseAgentMap }) {
  const history = useInfiniteQuery({
    queryKey: queryKeys.cases.handoffs(caseId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => casesApi.listHandoffs(caseId, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const historyView = useQueryView(history);
  const waiting = ["loading", "reconnecting"].includes(historyView.kind);
  const handoffs = history.data?.pages.flatMap(page => page.items) ?? [];
  return <section className="space-y-3" aria-label="Case handoffs">
    <h2 className="text-sm font-semibold">Handoffs</h2>
    {waiting ? <p className="text-sm text-muted-foreground">Loading handoffs…</p> : null}
    {(historyView.kind === "error") ? <p role="alert" className="text-sm text-destructive">Handoffs couldn’t be loaded.</p> : null}
    {!waiting && !(historyView.kind === "error") && handoffs.length === 0 ? <p className="text-sm text-muted-foreground">No handoffs yet.</p> : null}
    <ol className="divide-y divide-border">{handoffs.map(handoff => <HandoffRow key={handoff.id} handoff={handoff} task={task} agents={agents} />)}</ol>
    {history.hasNextPage ? <Button variant="ghost" size="sm" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load older handoffs</Button> : null}
  </section>;
}

function HandoffRow({ handoff, task, agents }: { handoff: CaseHandoffView; task?: CaseWorkIssue | null; agents?: CaseAgentMap }) {
  const createdAt = new Date(handoff.createdAt).toISOString();
  const terminal = handoff.destinationKind === "done";
  const settled = handoff.state === "delivered" || handoff.state === "completed";
  const stateLabel = handoff.state === "cancelled" ? (handoff.assignmentAppliedAt ? "Applied · delivery cancelled" : "Cancelled before transfer") : settled ? null
    : terminal ? "Waiting for task completion" : handoff.assignmentAppliedAt ? "Applied · waiting for delivery" : "Pending transfer";
  const handoffTask = task?.id === handoff.issueId ? task : null;
  return <li>
    <details className="group">
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded-sm py-3 marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast) group-open:rotate-90 motion-reduce:transition-none" />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium">{terminal ? "Done" : handoff.phase}{stateLabel && <span className="ml-2 text-xs font-normal text-muted-foreground">{stateLabel}</span>}</span>
            <span className="flex items-center gap-3">
              {handoffTask && <IssueReferencePill issue={handoffTask} variant="property" />}
              <time dateTime={createdAt} title={formatDateTime(createdAt)} className="font-mono text-xs text-muted-foreground">{relativeTime(createdAt)}</time>
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <HandoffActor id={handoff.fromAgentId} name={handoff.fromAgentName} fallback={handoff.actorType === "user" ? "User" : "System"} agents={agents} />
            <ArrowRight aria-hidden className="size-3" />
            {terminal ? <span className="text-xs">Done</span>
              : <HandoffActor id={handoff.toAgentId} name={handoff.toAgentName} fallback="Agent" agents={agents} />}
          </span>
        </span>
      </summary>
      <div className="space-y-2 pb-4 pl-6">
        {handoff.workflowTransition && <p className="text-xs text-muted-foreground">
          {handoff.workflowTransition.from.name ?? "Case instructions"}{handoff.workflowTransition.from.phase ? ` · ${handoff.workflowTransition.from.phase}` : ""}
          {" → "}{handoff.workflowTransition.to.name ?? "Case instructions"} · {handoff.workflowTransition.to.phase}
        </p>}
        {handoff.lastError && !settled && handoff.state !== "cancelled" ? <p className="text-xs text-muted-foreground">{handoff.lastError}</p> : null}
        <MarkdownBody linkIssueReferences linkCaseReferences>{handoff.instructions}</MarkdownBody>
        {handoff.recipientDecision?.outcome === "accepted" && handoff.offerContract ? <AcceptedRecoveryHistory
          caseId={handoff.caseId}
          handoffId={handoff.id}
          recipientId={handoff.recipientDecision.actorId}
          acceptedRevision={handoff.offerContract.requirementRevision.revision}
          agents={agents}
        /> : null}
      </div>
    </details>
  </li>;
}

const recoveryLabels: Record<string, string> = {
  active: "Active",
  escalated: "Escalated",
  resolved: "Resolved",
  cancelled: "Cancelled",
  agent: "Agent",
  board: "Board",
  system: "Proprio",
  completion_evidence_incomplete: "Incomplete completion evidence",
  criterion_claim_missing: "Criterion status missing",
  criterion_reported_not_satisfied: "Criterion not met",
  criterion_claim_not_satisfied: "Criterion not met",
  criterion_evidence_missing: "Required evidence missing",
  criterion_evidence_rejected: "Evidence rejected",
  criterion_evidence_unverifiable: "Evidence could not be verified",
};

function recoveryLabel(value: string | null) {
  if (!value) return null;
  return recoveryLabels[value] ?? value.replaceAll("_", " ").slice(0, 120);
}

function AcceptedRecoveryHistory({ caseId, handoffId, recipientId, acceptedRevision, agents }: {
  caseId: string;
  handoffId: string;
  recipientId: string;
  acceptedRevision: number;
  agents?: CaseAgentMap;
}) {
  const query = useQuery({
    queryKey: queryKeys.cases.handoffRecoveryHistory(caseId, handoffId),
    queryFn: () => casesApi.getHandoffRecoveryHistory(caseId, handoffId),
    enabled: false,
    retry: false,
  });
  const entries = query.isError || query.isFetching ? undefined : query.data?.entries;
  return <details className="group/recovery" onToggle={event => {
    if (event.currentTarget.open && !query.isFetching) void query.refetch();
  }}>
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast) group-open/recovery:rotate-90 motion-reduce:transition-none" />
      Recovery history <span className="text-xs font-normal text-muted-foreground">Accepted requirements · revision {acceptedRevision}</span>
    </summary>
    <div className="space-y-2 py-2 pl-6">
      {query.isFetching ? <p role="status" className="text-sm text-muted-foreground">Loading recovery history…</p> : null}
      {query.isError ? <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">Recovery history couldn’t be loaded.</p>
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
      </div> : null}
      {entries?.length === 0 ? <p className="text-sm text-muted-foreground">No recovery actions were recorded for this revision.</p> : null}
      {entries?.map(entry => <div key={entry.id} className="space-y-2 text-sm">
        <p className="font-medium">{recoveryLabel(entry.status)} · {recoveryLabel(entry.cause)}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Owner</span>
          {entry.ownerAgentId
            ? <HandoffActor id={entry.ownerAgentId} name={null} fallback="Agent" agents={agents} />
            : <span>{entry.ownerUserId ? "User" : recoveryLabel(entry.ownerType)}</span>}
          <span>· {entry.attemptCount}{entry.maxAttempts === null ? "" : ` of ${entry.maxAttempts}`} attempts</span>
          <span>· Assessed revision {entry.assessedRevision}</span>
          {entry.outcome && entry.outcome !== entry.status ? <span>· {recoveryLabel(entry.outcome)}</span> : null}
        </div>
        {(entry.status === "active" || entry.status === "escalated") && entry.nextAction
          ? <p className={`text-xs ${ANALYTICS_MASK_CLASS}`}>{entry.nextAction}</p> : null}
        {entry.resolutionNote ? <p className={`text-xs ${ANALYTICS_MASK_CLASS}`}>{entry.resolutionNote}</p> : null}
        {entry.criteria.map(criterion => <div key={criterion.criterionId} className="space-y-1 pl-3">
          <p className={`text-xs ${ANALYTICS_MASK_CLASS}`}>{criterion.requirement ?? "Acceptance criterion"}</p>
          <p className="text-xs text-muted-foreground">
            {[recoveryLabel(criterion.outcome), recoveryLabel(criterion.reasonCode)].filter(Boolean).join(" · ")}
          </p>
          {criterion.evidence.map((evidence, index) => <p key={index} className="text-xs text-muted-foreground">
            {["Evidence", recoveryLabel(evidence.outcome), recoveryLabel(evidence.reasonCode)].filter(Boolean).join(" · ")}
          </p>)}
        </div>)}
        {entry.attempts.length > 0 ? <ol className="space-y-1 pl-3 text-xs text-muted-foreground">
          {entry.attempts.map(attempt => <li key={attempt.decisionId} className="flex flex-wrap items-center gap-2">
            <Link to={`/agents/${recipientId}/runs/${attempt.runId}`} className="font-mono text-foreground underline underline-offset-2">
              Run {attempt.runId.slice(0, 8)}
            </Link>
            <span title={attempt.decisionId}>Decision <code>{attempt.decisionId.slice(0, 8)}</code></span>
            <span>{recoveryLabel(attempt.reasonCode)}</span>
          </li>)}
        </ol> : null}
      </div>)}
    </div>
  </details>;
}
