import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useCaseHref } from "@/lib/router";
import { casesApi, type CaseLinkRole, type CaseWorkIssue } from "@/api/cases";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { CaseHandoffHistory } from "@/components/cases/CaseHandoffHistory";

const ROLE_LABEL: Record<CaseLinkRole, string> = {
  origin: "origin",
  work: "work",
  reference: "reference",
};

/**
 * Issue-page right-rail section (P4 §5): the cases linked to this issue, each
 * with its link role + case status. Self-gates on the experimental Cases flag
 * and renders nothing when the flag is off or no cases are linked, so it can be
 * dropped into the issue properties panel unconditionally.
 */
type CurrentTask = Pick<CaseWorkIssue, "id" | "identifier" | "title" | "status">;

export function IssueCasesPanel({ task }: { task: CurrentTask }) {
  const issueId = task.id;
  const caseHref = useCaseHref();
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const enabled = experimentalSettings?.enableCases === true;

  const casesQuery = useQuery({
    queryKey: queryKeys.cases.forIssue(issueId),
    queryFn: () => casesApi.listForIssue(issueId),
    enabled: enabled && !!issueId,
  });

  const links = casesQuery.data ?? [];
  if (!enabled || links.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cases</h3>
      <div className="space-y-1">
        {links.map((link) => (
          <div key={link.id} className="space-y-1">
            <Link
              to={caseHref(link.case.identifier)}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm transition-colors hover:bg-accent/50"
            >
              <span className="font-mono text-xs text-muted-foreground shrink-0">{link.case.identifier}</span>
              <span className="min-w-0 flex-1 truncate" title={link.case.title}>{link.case.title}</span>
              <Badge variant="secondary" className="shrink-0">{link.case.workIssueId === issueId ? "workflow" : ROLE_LABEL[link.role]}</Badge>
              {link.case.workIssueId === issueId && link.case.phase ? (
                <span className="truncate text-xs text-muted-foreground">{link.case.phase}</span>
              ) : null}
              <StatusBadge status={link.case.status} />
            </Link>
            {link.case.workIssueId === issueId ? (
              <HandoffHistoryDisclosure caseId={link.case.id} task={task} />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function HandoffHistoryDisclosure({ caseId, task }: { caseId: string; task: CurrentTask }) {
  const [open, setOpen] = useState(false);

  return (
    <details className="pl-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        Show handoff decisions
      </summary>
      {open ? <CaseHandoffHistory caseId={caseId} task={task} /> : null}
    </details>
  );
}
