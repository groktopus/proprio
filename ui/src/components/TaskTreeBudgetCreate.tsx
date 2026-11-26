import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { BUDGET_AMOUNT_MAX_CENTS } from "@groktopus/shared";
import { ANALYTICS_MASK_CLASS } from "@/lib/analytics/privacy";
import { cn, formatCents } from "@/lib/utils";
import { parseBudgetDollarAmount } from "@/lib/budget-amount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const ROOT_SEARCH_PAGE_SIZE = 20;
const ROOT_SEARCH_DELAY_MS = 250;

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
  const amountErrorId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const restoreSearchFocus = useRef(false);
  const submitting = useRef(false);
  const [search, setSearch] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const amountCents = parseBudgetDollarAmount(amount);
  const invalidAmount = Boolean(amount.trim()) && amountCents === null;
  const searchText = search.trim();
  useEffect(() => {
    const timeout = window.setTimeout(() => setSettledSearch(searchText), ROOT_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [searchText]);
  const searchReady = searchText === settledSearch && settledSearch.length >= 2;
  const tasks = useInfiniteQuery({
    queryKey: queryKeys.issues.search(companyId, settledSearch, undefined, ROOT_SEARCH_PAGE_SIZE, "task-budget-roots"),
    queryFn: ({ pageParam, signal }) => issuesApi.list(companyId, {
      q: settledSearch, limit: ROOT_SEARCH_PAGE_SIZE, offset: pageParam, includeRoutineExecutions: true,
    }, { fresh: true, cache: "no-store", signal }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, offset) => last.length === ROOT_SEARCH_PAGE_SIZE ? offset + ROOT_SEARCH_PAGE_SIZE : undefined,
    enabled: !disabled && searchReady,
    staleTime: 10_000,
  });
  const existingIds = new Set(existingRootIds);
  const matches = searchReady && !tasks.error ? tasks.data?.pages.flat() ?? [] : [];
  const choices = [...new Map(matches.filter(task => !existingIds.has(task.id)).map(task => [task.id, task])).values()];
  const rootFromSearch = choices.find(task => task.id === selectedRootId);
  const selectedRootNeedsRead = selectedRootId !== null && !existingIds.has(selectedRootId) && !rootFromSearch;
  // Resetting a paged search starts it at the first page. Reauthorize a root
  // selected from a later page without discarding the operator's draft.
  const selectedRoot = useQuery({
    queryKey: [...queryKeys.issues.searches(companyId), "selected-budget-root", selectedRootId],
    queryFn: ({ signal }) => selectedRootId ? issuesApi.summaries(companyId, [selectedRootId], { signal, fresh: true }) : [],
    enabled: !disabled && selectedRootNeedsRead,
  });
  const root = disabled ? undefined : rootFromSearch ?? (selectedRootNeedsRead && !selectedRoot.error ? selectedRoot.data?.[0] : undefined);
  useLayoutEffect(() => {
    if (!root && searchInput.current && restoreSearchFocus.current) {
      restoreSearchFocus.current = false;
      searchInput.current.focus();
    }
  }, [root]);

  return (
    <form className="flex flex-wrap items-end gap-3 rounded-lg border border-border/70 p-4" onSubmit={async event => {
      event.preventDefault();
      if (disabled || isSaving || submitting.current || !root || amountCents === null) return;
      submitting.current = true;
      try {
        await onCreate(root.id, amountCents);
        restoreSearchFocus.current = true;
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
              <span className={cn("min-w-0 truncate", ANALYTICS_MASK_CLASS)}><span className="font-mono text-muted-foreground">{root.identifier ?? root.id.slice(0, 8)}</span> · {root.title}</span>
              <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={() => {
                restoreSearchFocus.current = true;
                setSelectedRootId(null);
                setSearch("");
              }}>Change root task</Button>
            </div>
          </>
        ) : (
          <>
            <label className="text-sm font-medium" htmlFor={searchId}>Root task</label>
            <Input id={searchId} ref={searchInput} value={search} onChange={event => { setSearch(event.target.value); setSelectedRootId(null); }}
              placeholder="Search tasks by title or ID" disabled={disabled || isSaving} />
            {searchText.length < 2 ? <p className="text-xs text-muted-foreground">Enter at least two characters to find a task.</p> : null}
            {searchReady && tasks.isFetching ? <output className="block text-xs text-muted-foreground">Searching tasks…</output> : null}
            {searchReady && tasks.error ? <p role="alert" className="text-xs text-destructive">Could not search tasks. Try again.</p> : null}
            {searchReady && tasks.data && !tasks.error && !tasks.hasNextPage && choices.length === 0 ? <output className="block text-xs text-muted-foreground">No tasks without a budget matched.</output> : null}
            {choices.length > 0 && !disabled ? (
              <ul className="max-h-48 space-y-1 overflow-auto" aria-label="Root task matches">
                {choices.map(task => (
                  <li key={task.id}>
                    <Button type="button" variant="ghost" className={cn("w-full justify-start whitespace-normal text-left", ANALYTICS_MASK_CLASS)} disabled={isSaving}
                      onClick={() => { setSelectedRootId(task.id); amountInput.current?.focus(); }}>
                      <span className="font-mono text-muted-foreground">{task.identifier ?? task.id.slice(0, 8)}</span> · {task.title}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
            {searchReady && tasks.hasNextPage && !disabled ? (
              <Button type="button" variant="outline" size="sm" disabled={isSaving || tasks.isFetching}
                onClick={() => { void tasks.fetchNextPage(); }}>
                More task results
              </Button>
            ) : null}
          </>
        )}
      </div>
      <div className="w-full space-y-2 sm:w-40">
        <label className="text-sm font-medium" htmlFor={amountId}>Lifetime limit (USD)</label>
        <Input id={amountId} ref={amountInput} inputMode="decimal" value={amount}
          onChange={event => setAmount(event.target.value)} placeholder="0.00" disabled={disabled || isSaving}
          aria-invalid={invalidAmount} aria-describedby={invalidAmount ? amountErrorId : undefined} />
        {invalidAmount && (
          <p id={amountErrorId} className="text-xs text-destructive">
            Enter an amount from $0.01 to {formatCents(BUDGET_AMOUNT_MAX_CENTS)} with up to two decimal places.
          </p>
        )}
      </div>
      <Button type="submit" disabled={disabled || isSaving || !root || amountCents === null}>
        {isSaving ? "Saving…" : "Set task budget"}
      </Button>
    </form>
  );
}
