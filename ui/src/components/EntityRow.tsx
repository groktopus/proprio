import { type ReactNode } from "react";
import { Link } from "@/lib/router";
import { cn } from "../lib/utils";

interface EntityRowProps {
  leading?: ReactNode;
  identifier?: string;
  title: string;
  titleAccessory?: ReactNode;
  subtitle?: ReactNode;
  /**
   * Optional metadata columns rendered immediately after the title. When set,
   * the title stops flex-growing and a spacer is inserted between `meta` and
   * `trailing`, so meta sits next to the name while trailing stays pinned right.
   */
  meta?: ReactNode;
  metaSpacerClassName?: string;
  trailing?: ReactNode;
  selected?: boolean;
  to?: string;
  onClick?: () => void;
  className?: string;
  titleClassName?: string;
  titleTextClassName?: string;
  subtitleClassName?: string;
  reserveSubtitleSpace?: boolean;
  /**
   * Make the title (the row's primary identifier) win the flex fight: it keeps a
   * usable min-width floor and ellipsizes, while the `meta` cluster is the item
   * that shrinks (and can wrap its own children). Without this, a wide `meta`
   * cluster starves the title down to zero at narrow widths. Opt-in so existing
   * callers keep the "title shrinks first" behavior.
   */
  titlePriority?: boolean;
  /**
   * Optional content rendered on its own full-width line beneath the main row.
   * Use this for a chip/action cluster that would otherwise starve the title at
   * narrow widths — gate it with `xl:hidden` and keep the inline copy in `meta`
   * behind `hidden xl:flex` so wide layouts are unchanged.
   */
  secondaryRow?: ReactNode;
  /** Override the secondary line's default spacing or indentation. */
  secondaryRowClassName?: string;
}

export function EntityRow({
  leading,
  identifier,
  title,
  titleAccessory,
  subtitle,
  meta,
  metaSpacerClassName,
  trailing,
  selected,
  to,
  onClick,
  className,
  titleClassName,
  titleTextClassName,
  subtitleClassName,
  reserveSubtitleSpace,
  titlePriority,
  secondaryRow,
  secondaryRowClassName,
}: EntityRowProps) {
  const isClickable = !!(to || onClick);
  const actionOnly = !to && Boolean(onClick);
  const Cell = actionOnly ? "span" : "div";
  const Subtitle = actionOnly ? "span" : "p";
  const shellClasses = cn(
    // When a secondaryRow is present the shell stacks (main line + secondary
    // line); otherwise the shell itself is the single flex row.
    secondaryRow ? "block" : "flex items-center gap-3",
    "px-4 py-2 text-sm border-b border-border last:border-b-0 transition-colors",
    isClickable && "cursor-pointer hover:bg-accent/50",
    selected && "bg-accent/30",
    className
  );

  const content = (
    <>
      {leading && <Cell className="flex items-center gap-2 shrink-0">{leading}</Cell>}
      <Cell
        className={cn(
          // `titlePriority` gives the name a floor so it ellipsizes instead of
          // collapsing to zero; otherwise the title may shrink to nothing.
          titlePriority ? "min-w-(--sz-6rem)" : "min-w-0",
          !meta && "flex-1",
          titleClassName,
        )}
      >
        <Cell className="flex items-center gap-2">
          {identifier && (
            <span className="text-xs text-muted-foreground font-mono shrink-0 relative top-(--sz-1px)">
              {identifier}
            </span>
          )}
          <span className={cn(!titleTextClassName && "truncate", titleTextClassName)} title={title}>
            {title}
          </span>
          {titleAccessory}
        </Cell>
        {(subtitle || reserveSubtitleSpace) && (
          <Subtitle
            className={cn(
              "text-xs text-muted-foreground mt-0.5 block min-h-4",
              !subtitleClassName && "truncate",
              subtitleClassName,
              !subtitle && "invisible",
            )}
            aria-hidden={!subtitle}
          >
            {subtitle}
          </Subtitle>
        )}
      </Cell>
      {meta && (
        <Cell
          className={cn(
            "flex items-center gap-2",
            // In title-priority mode the meta cluster yields (shrinks/wraps)
            // before the name does; otherwise it holds its width.
            titlePriority ? "min-w-0 shrink" : "shrink-0",
          )}
        >
          {meta}
        </Cell>
      )}
      {meta && <Cell className={cn("flex-1", metaSpacerClassName)} />}
      {trailing && <Cell className="flex items-center gap-2 shrink-0">{trailing}</Cell>}
    </>
  );

  // With a secondaryRow, wrap the main line in its own flex row and stack the
  // secondary content beneath it (indented to align under the title, past the
  // leading capsule). Without it, `content` is rendered directly (unchanged).
  const body = secondaryRow ? (
    <>
      <Cell className="flex items-center gap-3">{content}</Cell>
      <Cell className={cn("mt-1 pl-5", secondaryRowClassName)}>{secondaryRow}</Cell>
    </>
  ) : (
    content
  );

  if (to) {
    return (
      <Link to={to} className={cn("no-underline text-inherit", shellClasses)} onClick={onClick}>
        {body}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        className={cn("w-full text-left focus-visible:outline-2 focus-visible:outline-ring", shellClasses)}
        aria-pressed={selected}
        onClick={onClick}
      >
        {body}
      </button>
    );
  }

  return <div className={shellClasses}>{body}</div>;
}
