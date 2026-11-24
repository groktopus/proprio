import { Link } from "@/lib/router";
import type { InboxTab } from "@/lib/inbox";

const views = [
  { value: "mine", label: "Mine" },
  { value: "recent", label: "Recent" },
  { value: "unread", label: "Unread" },
  { value: "blocked", label: "Blocked" },
  { value: "all", label: "All" },
] as const;

export function InboxViewNavigation({ current }: { current: InboxTab }) {
  return (
    <nav aria-label="Inbox views" data-canonical-tabs="standard" className="canonical-tab-list">
      {views.map(({ value, label }) => (
        <Link
          key={value}
          to={`/inbox/${value}`}
          aria-current={current === value ? "page" : undefined}
          className="canonical-tab no-underline"
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
