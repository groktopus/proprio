import type { InboxTab } from "@/lib/inbox";
import { RouteTabBar } from "./RouteTabBar";

const views = [
  { href: "/inbox/mine", label: "Mine" },
  { href: "/inbox/recent", label: "Recent" },
  { href: "/inbox/unread", label: "Unread" },
  { href: "/inbox/blocked", label: "Blocked" },
  { href: "/inbox/all", label: "All" },
];

export function InboxViewNavigation({ current }: { current: InboxTab }) {
  return <RouteTabBar label="Inbox views" current={`/inbox/${current}`} items={views} />;
}
