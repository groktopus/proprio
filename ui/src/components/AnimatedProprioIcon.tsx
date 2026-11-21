import type { SVGProps } from "react";
import { cn } from "../lib/utils";
import { useBlockingPageGate } from "../hooks/usePageContentReady";

export function AnimatedProprioIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="-1 -1 26 26"
      className={cn("proprio-thinking-icon", className)}
      aria-hidden="true"
      {...props}
    >
      <path
        className="proprio-thinking-icon-path"
        d="M7 19V5h6a4.5 4.5 0 0 1 0 9H7m10 4h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Full-page loading state: a large, centered, gray animated proprio. */
export function ProprioLoading({ className }: { className?: string }) {
  // While a full-page loading state is on screen the page has not loaded.
  useBlockingPageGate();
  return (
    <div
      role="status"
      className={cn("flex min-h-dvh w-full items-center justify-center", className)}
    >
      <AnimatedProprioIcon className="h-24 w-24 text-muted-foreground" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
