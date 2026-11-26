import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { parseBudgetDollarAmount } from "@/lib/budget-amount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  onCreate: (rootTaskId: string, amountCents: number) => Promise<unknown>;
}) {
  const searchId = useId();
  const amountId = useId();
  const amountInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [search, setSearch] = useState("");
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const amountCents = parseBudgetDollarAmount(amount);
  const query = search.trim();
  const tasks = useQuery({
    queryKey: queryKeys.budgets.rootSearch(companyId, query),
    queryFn: () => issuesApi.list(companyId, { q: query, limit: 20, includeRoutineExecutions: true, includeAgentCreatedTasks: true }),
    enabled: !disabled && query.length >= 2,
    staleTime: 10_000,
  });
  const existingIds = new Set(existingRootIds);
  const choices = (tasks.data ?? []).filter(task => !existingIds.has(task.id));
  const root = disabled ? undefined : choices.find(task => task.id === selectedRootId);

  return (
    <form className="flex flex-wrap items-end gap-3 rounded-lg border border-border/70 p-4" onSubmit={async event => {
      event.preventDefault();
      if (disabled || isSaving || submitting.current || !root || amountCents === null) return;
      submitting.current = true;
      try {
        await onCreate(root.id, amountCents);
        setSelectedRootId(null);
        setSearch("");
        setAmount("");
      } catch {
        // Keep the draft so the operator can retry. Costs displays the request error.
      } finally {
        submitting.current = false;
      }
    }}>
      <div className="min-w-0 flex-1 space-y-2">
        {root ? (
          <>
            <span className="text-sm font-medium">Root task</span>
            <div className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-input px-3 py-2 text-sm">
              <span className="min-w-0 truncate"><span className="font-mono text-muted-foreground">{root.identifier ?? root.id.slice(0, 8)}</span> · {root.title}</span>
              <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={() => { setSelectedRootId(null); setSearch(""); }}>Change root task</Button>
            </div>
          </>
        ) : (
          <>
            <label className="text-sm font-medium" htmlFor={searchId}>Root task</label>
            <Input id={searchId} value={search} onChange={event => { setSearch(event.target.value); setSelectedRootId(null); }}
              placeholder="Search tasks by title or ID" disabled={disabled || isSaving} />
            {query.length < 2 ? <p className="text-xs text-muted-foreground">Enter at least two characters to find a task.</p> : null}
            {tasks.isFetching ? <output className="block text-xs text-muted-foreground">Searching tasks…</output> : null}
            {tasks.error ? <p role="alert" className="text-xs text-destructive">Could not search tasks. Try again.</p> : null}
            {tasks.data && choices.length === 0 ? <output className="block text-xs text-muted-foreground">No tasks without a budget matched.</output> : null}
            {choices.length > 0 && !disabled ? (
              <ul className="max-h-48 space-y-1 overflow-auto" aria-label="Root task matches">
                {choices.map(task => (
                  <li key={task.id}>
                    <Button type="button" variant="ghost" className="w-full justify-start whitespace-normal text-left" disabled={isSaving}
                      onClick={() => { setSelectedRootId(task.id); amountInput.current?.focus(); }}>
                      <span className="font-mono text-muted-foreground">{task.identifier ?? task.id.slice(0, 8)}</span> · {task.title}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>
      <div className="w-full space-y-2 sm:w-40">
        <label className="text-sm font-medium" htmlFor={amountId}>Lifetime limit (USD)</label>
        <Input id={amountId} ref={amountInput} aria-label="Lifetime limit (USD)" inputMode="decimal" value={amount}
          onChange={event => setAmount(event.target.value)} placeholder="0.00" disabled={disabled || isSaving}
          aria-invalid={Boolean(amount.trim()) && amountCents === null} />
      </div>
      <Button type="submit" disabled={disabled || isSaving || !root || amountCents === null}>
        {isSaving ? "Saving…" : "Set task budget"}
      </Button>
    </form>
  );
}
