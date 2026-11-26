import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { casesApi } from "@/api/cases";
import { classifyError } from "@/api/errors";
import { AgentIdentity } from "@/components/AgentIdentity";
import { Button } from "@/components/ui/button";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import type { CaseAgentMap } from "./CaseWorkSummary";

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

export function AcceptedRecoveryHistory({ caseId, handoffId, recipientId, acceptedRevision, agents }: {
  caseId: string;
  handoffId: string;
  recipientId: string;
  acceptedRevision: number;
  agents?: CaseAgentMap;
}) {
  const [open, setOpen] = useState(false);
  return <details className="group/recovery" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-sm font-medium marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast) group-open/recovery:rotate-90 motion-reduce:transition-none" />
      Recovery history <span className="text-xs font-normal text-muted-foreground">Accepted requirements · revision {acceptedRevision}</span>
    </summary>
    {open && <RecoveryHistory caseId={caseId} handoffId={handoffId} recipientId={recipientId} agents={agents} />}
  </details>;
}

function RecoveryHistory({ caseId, handoffId, recipientId, agents }: {
  caseId: string;
  handoffId: string;
  recipientId: string;
  agents?: CaseAgentMap;
}) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.cases.handoffRecoveryHistory(caseId, handoffId);
  const query = useQuery({
    queryKey,
    refetchOnMount: "always",
    retry: false,
    queryFn: async ({ signal }) => {
      try {
        return await casesApi.getHandoffRecoveryHistory(caseId, handoffId, signal);
      } catch (error) {
        const kind = classifyError(error);
        if (!signal.aborted && (kind === "auth" || kind === "forbidden" || kind === "not_found")) {
          queryClient.setQueryData(queryKey, { entries: [] });
        }
        throw error;
      }
    },
  });
  const waiting = query.isPending || query.fetchStatus !== "idle";
  const entries = query.isSuccess && !waiting ? query.data.entries : undefined;
  return (
    <div className="space-y-2 py-2 pl-6">
      {waiting ? <p role="status" className="text-sm text-muted-foreground">Loading recovery history…</p> : null}
      {!waiting && query.isError ? <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">Recovery history couldn’t be loaded.</p>
        <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Retry</Button>
      </div> : null}
      {entries?.length === 0 ? <p className="text-sm text-muted-foreground">No recovery actions were recorded for this revision.</p> : null}
      {entries?.map(entry => <div key={entry.id} className="space-y-2 text-sm">
        <p className="font-medium">{recoveryLabel(entry.status)} · {recoveryLabel(entry.cause)}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Owner</span>
          {entry.ownerAgentId
            ? <AgentIdentity agent={agents?.get(entry.ownerAgentId) ?? { id: entry.ownerAgentId, name: "Agent" }} size="xs" />
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
            <Link to={`/agents/${recipientId}/runs/${attempt.runId}`} className={`font-mono text-foreground underline underline-offset-2 ${ANALYTICS_MASK_CLASS}`}>
              Run {attempt.runId.slice(0, 8)}
            </Link>
            <span title={attempt.decisionId}>Decision <code className={ANALYTICS_MASK_CLASS}>{attempt.decisionId.slice(0, 8)}</code></span>
            <span>{recoveryLabel(attempt.reasonCode)}</span>
          </li>)}
        </ol> : null}
      </div>)}
    </div>
  );
}
