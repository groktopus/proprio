import type { ReactNode } from "react";
import { Link } from "@/lib/router";

export function RouteTabBar({ label, current, items }: {
  label: string;
  current: string;
  items: readonly { href: string; label: ReactNode }[];
}) {
  return (
    <nav aria-label={label} data-canonical-tabs="standard" className="canonical-tab-list">
      {items.map((item) => (
        <Link
          key={item.href}
          to={item.href}
          aria-current={item.href === current ? "page" : undefined}
          className="canonical-tab no-underline"
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
