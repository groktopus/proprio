import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import type { ToolActionRequestListItem } from "@groktopus/shared";
import { humanizeConnectionDisplayName } from "@groktopus/shared";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { timeAgo } from "@/lib/timeAgo";
import { issuesApi } from "@/api/issues";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { describeError } from "@/api/errors";

/**
 * "Ask first" review queue (M1b float / M9 card, PAP-10859).
 *
 * Renders pending `tool_action_requests` as prosumer cards with three choices:
 *   • Allow once   → approve this single request
 *   • Always allow → approve + create a trust rule (won't ask again)
 *   • Decline      → reject this request
 *
 * Pass `connectionId` to scope the queue to a single app (App detail); omit it
 * to show every pending request (Needs attention page).
 */
export function ReviewQueueCard({
  connectionId,
  emptyState = "hidden",
  heading = "Waiting for your OK",
  plain = false,
}: {
  connectionId?: string;
  emptyState?: "hidden" | "reassure";
  heading?: string;
  plain?: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<{
    companyId: string;
    connectionId: string | undefined;
    message: string;
    moveFocus: boolean;
  } | null>(null);
  const visibleFailure = failure?.companyId === selectedCompanyId && failure.connectionId === connectionId
    ? failure
    : null;

  const handledFailure = useRef<typeof failure>(null);
  useEffect(() => {
    if (!failure || handledFailure.current === failure) return;
    handledFailure.current = failure;
    if (visibleFailure?.moveFocus) feedbackRef.current?.focus();
  }, [failure, visibleFailure]);

  const query = useQuery({
    queryKey: queryKeys.tools.actionRequests(selectedCompanyId ?? "__none__", "pending"),
    queryFn: () => toolsApi.listActionRequests(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
    refetchInterval: 20_000,
  });
  const view = useQueryView(query);

  const items = useMemo(() => {
    const all = query.data?.actionRequests ?? [];
    return connectionId ? all.filter((item) => item.connectionId === connectionId) : all;
  }, [query.data, connectionId]);

  if (!selectedCompanyId) return null;
  if (query.isLoading || view.kind === "reconnecting") return null;
  if (view.kind === "error") return <QueryErrorState error={query.error} action="load connection reviews" onRetry={view.retry} retrying={view.isFetching} />;

  return (
    <>
      <div ref={feedbackRef} aria-live="polite" aria-atomic="true" tabIndex={-1}
        className={visibleFailure ? "mb-3 rounded-sm border border-destructive/60 bg-destructive/10 p-3 text-sm text-destructive" : undefined}>
        {visibleFailure ? (
          <>
            <p className="font-semibold">Approved action failed</p>
            <p>{visibleFailure.message}</p>
          </>
        ) : null}
      </div>
      {items.length === 0 ? (
        emptyState === "reassure" ? (
          <div className={plain ? "py-5 text-sm text-muted-foreground" : "rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground"}>
            Nothing is waiting for your OK right now.
          </div>
        ) : null
      ) : (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <ShieldQuestion className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-bold text-foreground">{heading}</h2>
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
              {items.length}
            </span>
          </div>
          <div className="space-y-3">
            {items.map((item) => (
              <ReviewRow key={item.request.id} companyId={selectedCompanyId} item={item} plain={plain}
                onFailure={(message, moveFocus) => setFailure({ companyId: selectedCompanyId, connectionId, message, moveFocus })} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function ReviewRow({
  companyId,
  item,
  plain,
  onFailure,
}: {
  companyId: string;
  item: ToolActionRequestListItem;
  plain: boolean;
  onFailure: (message: string, moveFocus: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const rowRef = useRef<HTMLDivElement>(null);
  const [resolving, setResolving] = useState<null | "allow" | "always" | "decline">(null);

  const interactionQuery = useQuery({
    queryKey: queryKeys.issues.interactions(item.request.issueId ?? "__none__"),
    queryFn: () => issuesApi.listInteractions(item.request.issueId!),
    enabled: Boolean(item.request.issueId && item.request.interactionId),
  });
  const linkedInteraction = interactionQuery.data?.find(row => row.id === item.request.interactionId);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.actionRequests(companyId, "pending") });
    queryClient.invalidateQueries({ queryKey: queryKeys.apps.attention(companyId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.tools.trustRules(companyId) });
    if (item.request.issueId) queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(item.request.issueId) });
  };

  async function approve(rememberAction: boolean) {
    const result = await toolsApi.approveActionRequest(companyId, item.request.id, rememberAction);
    if (result.status === "failed") {
      const reason = result.error?.trim() || "The gateway returned no failure details.";
      return rememberAction ? `${reason} Future calls may still be allowed.` : reason;
    }
    if (result.status !== "approved" && result.status !== "executing" && result.status !== "executed") {
      throw new Error("The approval did not complete. Refresh the review queue to check its latest status.");
    }
    return null;
  }

  function reportFailure(message: string, startedWithFocus: boolean) {
    const activeElement = document.activeElement;
    const moveFocus = Boolean(rowRef.current?.contains(activeElement))
      || (startedWithFocus && activeElement === document.body);
    onFailure(message, moveFocus);
  }

  const approveAction = useMutation({
    mutationFn: approve,
    onMutate: (rememberAction) => {
      const startedWithFocus = Boolean(rowRef.current?.contains(document.activeElement));
      setResolving(rememberAction ? "always" : "allow");
      return startedWithFocus;
    },
    onSuccess: (failure, rememberAction, startedWithFocus) => {
      if (failure) {
        reportFailure(failure, startedWithFocus ?? false);
      } else if (rememberAction) {
        pushToast({
          title: "Always allowed",
          body: `${actionLabel(item)} won’t ask again.`,
          tone: "success",
        });
      } else {
        pushToast({ title: "Allowed once", body: `${actionLabel(item)} can run this time.`, tone: "success" });
      }
      invalidate();
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error);
    },
    onSettled: () => setResolving(null),
  });

  const decline = useMutation({
    mutationFn: () => toolsApi.declineActionRequest(companyId, item.request.id),
    onMutate: () => setResolving("decline"),
    onSuccess: () => {
      pushToast({ title: "Declined", body: `${actionLabel(item)} won’t run.`, tone: "info" });
      invalidate();
    },
    onError: (error) => {
      invalidate();
      failToast(pushToast, error);
    },
    onSettled: () => setResolving(null),
  });

  if (linkedInteraction) return (
    <div ref={rowRef}>
      <IssueThreadInteractionCard
        interaction={linkedInteraction}
        onAcceptInteraction={async (_interaction, _keys, _options, rememberAction) => {
          const startedWithFocus = Boolean(rowRef.current?.contains(document.activeElement));
          try {
            const failure = await approve(rememberAction ?? false);
            if (failure) reportFailure(failure, startedWithFocus);
          } finally {
            invalidate();
          }
        }}
        onRejectInteraction={async (_interaction, reason) => {
          try { await toolsApi.declineActionRequest(companyId, item.request.id, reason); }
          finally { invalidate(); }
        }}
      />
    </div>
  );

  const busy = resolving !== null;
  const preview = item.request.previewMarkdown?.trim();

  return (
    <div ref={rowRef} className={plain ? "py-3" : "rounded-xl border border-border bg-card p-4"}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-bold text-foreground">{actionLabel(item)}</span>
        {item.applicationName && (
          <span className="text-muted-foreground">
            in {humanizeConnectionDisplayName(item.applicationName)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">· asked {timeAgo(item.request.createdAt)}</span>
      </div>

      {preview ? (
        <div className="mt-2 rounded-lg border border-border bg-background px-3 py-2 text-sm">
          <MarkdownBody>{preview}</MarkdownBody>
        </div>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          An agent wants to run this action. Your connection policy requires approval first.
        </p>
      )}

      {item.requestedByAgentId && item.connectionId && !item.request.approvalId ? <p className="mt-2 text-xs text-muted-foreground">Always allow lets this agent use this action with different arguments on this connection, within the current project when present.</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => approveAction.mutate(false)} disabled={busy}>
          {resolving === "allow" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
          Allow once
        </Button>
        {item.requestedByAgentId && item.connectionId && !item.request.approvalId ? <Button size="sm" variant="outline" onClick={() => approveAction.mutate(true)} disabled={busy}>
          {resolving === "always" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          Always allow
        </Button> : null}
        <Button size="sm" variant="ghost" onClick={() => decline.mutate()} disabled={busy}>
          {resolving === "decline" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1.5 h-3.5 w-3.5" />}
          Decline
        </Button>
      </div>
    </div>
  );
}

function actionLabel(item: ToolActionRequestListItem): string {
  if (!item.toolTitle && !item.toolName) return "This action";
  return humanizeConnectionDisplayName(item.toolName ?? "", { title: item.toolTitle });
}

function failToast(
  pushToast: ReturnType<typeof useToast>["pushToast"],
  error: unknown,
) {
  pushToast({
    title: "Couldn’t save that",
    body: describeError(error).body,
    tone: "error",
  });
}
