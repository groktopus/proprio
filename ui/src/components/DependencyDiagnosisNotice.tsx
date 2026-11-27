import type { DependencyDiagnosis, IssueRelationIssueSummary } from "@groktopus/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { describeError } from "@/api/errors";
import { Button } from "@/components/ui/button";
import { createIssueDetailPath } from "@/lib/issueDetailBreadcrumb";
import { resolveTaskStatusPresentation } from "@/lib/task-status-presentation";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useState } from "react";

const wakeLabels: Record<DependencyDiagnosis["wake"]["status"], string> = {
  not_requested: "No diagnostic wake has been requested.",
  queued: "The parent wake is queued.",
  running: "The parent assignee is investigating.",
  deferred: "The parent wake was deferred.",
  refused: "The parent wake was refused.",
  exhausted: "The parent wake has exhausted its attempts.",
  completed: "The parent diagnostic turn completed.",
};

const stateLabels: Record<DependencyDiagnosis["state"], string> = {
  no_execution_path: "No execution path",
  active: "Dependency in progress",
  external_wait: "Waiting on an external dependency",
  restricted: "Restricted dependency",
};

function humanizeKind(kind: string): string {
  return kind.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function ownerLabel(owner: DependencyDiagnosis["nextOwner"]): string {
  if (owner.name?.trim()) return owner.name;
  if (owner.type === "agent") return "The assigned agent";
  if (owner.type === "user") return "The task owner";
  return "The board";
}

type DependencyDiagnosisNoticeProps = {
  issueId: string;
  diagnosis: DependencyDiagnosis | null | undefined;
  canRequest: boolean;
  blockerSummaries?: readonly IssueRelationIssueSummary[];
  diagnosisError?: string | null;
  onRetryDiagnosis?: () => void;
};

export function DependencyDiagnosisNotice(props: DependencyDiagnosisNoticeProps) {
  const hasDiagnosis = Boolean(props.diagnosis || props.diagnosisError);
  const [hasShownDiagnosis, setHasShownDiagnosis] = useState(hasDiagnosis);
  if (hasDiagnosis && !hasShownDiagnosis) setHasShownDiagnosis(true);
  if (!hasDiagnosis && !hasShownDiagnosis) return null;
  return <DependencyDiagnosisPanel key={props.issueId} {...props} />;
}

function DependencyDiagnosisPanel({
  issueId,
  diagnosis,
  canRequest,
  blockerSummaries = [],
  diagnosisError,
  onRetryDiagnosis,
}: DependencyDiagnosisNoticeProps) {
  const queryClient = useQueryClient();
  const request = useMutation({
    mutationFn: ({ taskId, input }: { taskId: string; input: Parameters<typeof issuesApi.requestDependencyInvestigation>[1] }) =>
      issuesApi.requestDependencyInvestigation(taskId, input),
    retry: false,
    onSuccess: async (_result, { taskId }) => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(taskId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.dependencyInvestigation(taskId) }),
    ]),
  });
  const submittedHere = request.variables?.taskId === issueId;
  const resultMessage = submittedHere && request.data?.accepted === false ? request.data.message : null;
  const requestError = submittedHere && request.error ? describeError(request.error).body : null;

  if (!diagnosis) {
    if (!diagnosisError && !resultMessage && !requestError) return null;
    return (
      <section data-testid="dependency-diagnosis-notice" className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        {resultMessage ? <p role="alert" className="text-destructive">{resultMessage}</p> : null}
        {requestError ? <p role="alert" className="text-destructive">{requestError}</p> : null}
        {diagnosisError ? <p role="alert" className="text-destructive">Could not load dependency diagnosis: {diagnosisError}</p> : null}
        {diagnosisError && onRetryDiagnosis ? <Button type="button" size="sm" variant="outline" onClick={onRetryDiagnosis}>Reload</Button> : null}
      </section>
    );
  }

  const causeTask = diagnosis.cause.issueId
    ? diagnosis.dependencyPath.find(task => task.issueId === diagnosis.cause.issueId)
    : undefined;
  const causeLabel = `${humanizeKind(diagnosis.cause.kind)}${causeTask
    ? ` — ${causeTask.identifier ? `${causeTask.identifier}: ` : ""}${causeTask.title}`
    : ""}`;
  const idempotencyKey = diagnosis.wake.idempotencyKey;
  const canSubmit = Boolean(diagnosis.canInvestigate && canRequest && idempotencyKey);
  const requestMatchesDiagnosis = submittedHere && request.variables?.input.idempotencyKey === idempotencyKey;
  const isRequestPending = request.isPending && submittedHere;
  const summariesByIssueId = new Map(blockerSummaries
    .flatMap(blocker => [blocker, ...(blocker.terminalBlockers ?? [])])
    .map(blocker => [blocker.id, blocker]));
  const submitRequest = () => {
    if (canSubmit && idempotencyKey) request.mutate({ taskId: issueId, input: { idempotencyKey } });
  };

  return (
    <section
      data-testid="dependency-diagnosis-notice"
      aria-label="Dependency diagnosis"
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {stateLabels[diagnosis.state]}
      </div>

      <div className="text-muted-foreground">
        Cause: <span className="text-foreground">{causeLabel}</span>
      </div>

      {diagnosis.dependencyPath.length > 0 ? (
        <ol aria-label="Dependency path" className="flex flex-wrap items-center gap-x-1 text-xs">
          {diagnosis.dependencyPath.map((task, index) => (
            <li key={task.issueId} className="inline-flex items-center gap-1">
              {index > 0 ? <span aria-hidden>→</span> : null}
              <Link to={createIssueDetailPath(task.identifier ?? task.issueId)} className="underline-offset-2 hover:underline">
                {task.identifier ? `${task.identifier}: ${task.title}` : task.title}
              </Link>
              <span className="text-muted-foreground">({resolveTaskStatusPresentation({
                status: task.status, displayStatus: summariesByIssueId.get(task.issueId)?.displayStatus,
              }).label})</span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="text-muted-foreground">
        Next: <span className="text-foreground">{ownerLabel(diagnosis.nextOwner)} — {diagnosis.nextAction}</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p data-testid="dependency-parent-wake-state" role="status" className="text-xs text-muted-foreground">
          {wakeLabels[diagnosis.wake.status]}
        </p>
        {canSubmit ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRequestPending}
            onClick={submitRequest}
          >
            {isRequestPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Ask assignee to investigate
          </Button>
        ) : null}
      </div>

      {requestMatchesDiagnosis && request.isSuccess && request.data.accepted &&
      (diagnosis.wake.status === "not_requested" || diagnosis.wake.status === "exhausted") ? (
        <p role="status" className="text-xs text-muted-foreground">Request accepted.</p>
      ) : null}
      {resultMessage ? <p role="alert" className="text-xs text-destructive">{resultMessage}</p> : null}
      {requestError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>{requestError} If the response was lost, retrying will use the same request.</span>
          {canSubmit && requestMatchesDiagnosis ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={submitRequest}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
      {diagnosisError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
          <span>Could not refresh dependency diagnosis: {diagnosisError}</span>
          {onRetryDiagnosis ? <Button type="button" size="sm" variant="outline" onClick={onRetryDiagnosis}>Reload</Button> : null}
        </div>
      ) : null}
    </section>
  );
}
