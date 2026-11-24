import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@groktopus/shared";
import { issuesApi } from "../api/issues";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function parseAmount(value: string) {
  const amount = Number(value.trim());
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

export function TaskTreeBudgetCreate({
  companyId,
  existingRootIds,
  disabled,
  isSaving,
  onCreate,
}: {
  companyId: string;
  existingRootIds: readonly string[];
  disabled?: boolean;
  isSaving?: boolean;
  onCreate: (rootTask: Issue, amountCents: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [rootTask, setRootTask] = useState<Issue | null>(null);
  const [amount, setAmount] = useState("");
  const parsedAmount = parseAmount(amount);
  const tasks = useQuery({
    queryKey: ["task-tree-budget-root-search", companyId, search.trim()],
    queryFn: () => issuesApi.list(companyId, { q: search.trim(), limit: 20, includeRoutineExecutions: true, includeAgentCreatedTasks: true }),
    enabled: !disabled && search.trim().length >= 2 && !rootTask,
    staleTime: 10_000,
  });
  const existingIds = new Set(existingRootIds);
  const choices = (tasks.data ?? []).filter(task => !existingIds.has(task.id));

  return (
    <form className="grid gap-3 rounded-lg border border-border/70 p-4 md:grid-cols-[minmax(14rem,1fr)_10rem_auto] md:items-end" onSubmit={event => {
      event.preventDefault();
      if (rootTask && parsedAmount !== null && !disabled) onCreate(rootTask, parsedAmount);
    }}>
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="task-tree-budget-root-search">Root task</label>
        {rootTask ? (
          <div className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-input px-3 py-2 text-sm" aria-label="Selected root task">
            <span className="min-w-0 truncate"><span className="font-mono text-muted-foreground">{rootTask.identifier ?? rootTask.id.slice(0, 8)}</span> · {rootTask.title}</span>
            <Button type="button" variant="ghost" size="sm" disabled={disabled || isSaving} onClick={() => { setRootTask(null); setSearch(""); }}>Change</Button>
          </div>
        ) : (
          <>
            <Input id="task-tree-budget-root-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tasks by title or ID" disabled={disabled || isSaving} />
            {search.trim().length < 2 ? <p className="text-xs text-muted-foreground">Enter at least two characters to find a visible task.</p> : null}
            {tasks.isFetching ? <p role="status" className="text-xs text-muted-foreground">Searching tasks…</p> : null}
            {tasks.error ? <p role="alert" className="text-xs text-destructive">Could not search tasks. Try again.</p> : null}
            {tasks.data && choices.length === 0 ? <p role="status" className="text-xs text-muted-foreground">No unbudgeted visible task matches. Existing roots already have policies.</p> : null}
            {choices.length > 0 ? (
              <div className="max-h-48 space-y-1 overflow-auto" aria-label="Root task matches">
                {choices.map(task => (
                  <button key={task.id} type="button" className="block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => setRootTask(task)}>
                    <span className="font-mono text-muted-foreground">{task.identifier ?? task.id.slice(0, 8)}</span> · {task.title}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
      <label className="space-y-2 text-sm font-medium">Lifetime limit (USD)
        <Input aria-label="Lifetime limit (USD)" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" disabled={disabled || isSaving} />
      </label>
      <Button type="submit" disabled={disabled || isSaving || !rootTask || parsedAmount === null}>
        {isSaving ? "Saving…" : "Set task budget"}
      </Button>
    </form>
  );
}
