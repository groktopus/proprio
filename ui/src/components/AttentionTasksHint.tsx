import { Link } from "@/lib/router";
import { useCombinedInboxTasksEnabled } from "@/hooks/useCombinedInboxTasksEnabled";

/** Inline destination guidance shared by Classic and Coordinator attention desks. */
export function AttentionTasksHint() {
  const { enabled } = useCombinedInboxTasksEnabled();
  const destination = enabled ? "/issues" : "/inbox";
  return (
    <>
      Pending decisions live here. Use <Link to={destination} className="underline underline-offset-4">Tasks</Link> for filtered work views such as Mine, Unread, and Blocked.
    </>
  );
}
