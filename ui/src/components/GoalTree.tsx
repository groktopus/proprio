import type { Goal } from "@groktopus/shared";
import { Link } from "@/lib/router";
import { StatusBadge } from "./StatusBadge";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { useMemo, useState } from "react";

const noGoals: Goal[] = [];

interface GoalTreeProps {
  goals: Goal[];
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
}

interface GoalNodeProps {
  goal: Goal;
  children: Goal[];
  childrenByParent: Map<string, Goal[]>;
  depth: number;
  goalLink?: (goal: Goal) => string;
  onSelect?: (goal: Goal) => void;
}

function GoalNode({ goal, children, childrenByParent, depth, goalLink, onSelect }: GoalNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = children.length > 0;
  const link = goalLink?.(goal);

  const inner = (
    <>
      {hasChildren ? (
        <button
          className="p-0.5"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          aria-label={`${goal.title} subtree`}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")}
          />
        </button>
      ) : (
        <span className="w-4" />
      )}
      <span className="text-xs text-muted-foreground capitalize">{goal.level}</span>
      <span className="flex-1 truncate">{goal.title}</span>
      <StatusBadge status={goal.status} />
    </>
  );

  const classes = cn(
    "flex items-center gap-2 px-3 py-1.5 text-sm transition-colors cursor-pointer hover:bg-accent/50",
  );

  return (
    <div>
      {link ? (
        <Link
          to={link}
          className={cn(classes, "no-underline text-inherit")}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          {inner}
        </Link>
      ) : (
        <div
          className={classes}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          onClick={() => onSelect?.(goal)}
        >
          {inner}
        </div>
      )}
      {hasChildren && expanded && (
        <div>
          {children.map((child) => (
            <GoalNode
              key={child.id}
              goal={child}
              children={childrenByParent.get(child.id) ?? noGoals}
              childrenByParent={childrenByParent}
              depth={depth + 1}
              goalLink={goalLink}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree({ goals, goalLink, onSelect }: GoalTreeProps) {
  const { roots, childrenByParent, disconnected } = useMemo(() => {
    const goalIds = new Set(goals.map(goal => goal.id));
    const roots: Goal[] = [];
    const childrenByParent = new Map<string, Goal[]>();
    for (const goal of goals) {
      if (!goal.parentId || !goalIds.has(goal.parentId)) {
        roots.push(goal);
        continue;
      }
      const children = childrenByParent.get(goal.parentId);
      if (children) children.push(goal);
      else childrenByParent.set(goal.parentId, [goal]);
    }

    const reached = new Set<string>();
    const pending = [...roots];
    for (let index = 0; index < pending.length; index += 1) {
      const goal = pending[index]!;
      if (reached.has(goal.id)) continue;
      reached.add(goal.id);
      for (const child of childrenByParent.get(goal.id) ?? noGoals) pending.push(child);
    }
    return { roots, childrenByParent, disconnected: goals.filter(goal => !reached.has(goal.id)) };
  }, [goals]);

  if (goals.length === 0) {
    return <p className="text-sm text-muted-foreground">No goals.</p>;
  }

  return (
    <div className="border border-border py-1">
      {roots.map((goal) => (
        <GoalNode
          key={goal.id}
          goal={goal}
          children={childrenByParent.get(goal.id) ?? noGoals}
          childrenByParent={childrenByParent}
          depth={0}
          goalLink={goalLink}
          onSelect={onSelect}
        />
      ))}
      {disconnected.length > 0 && (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          Some goals have cyclic parent links. Clear a parent through the CLI or API to repair the hierarchy.
        </p>
      )}
      {disconnected.map(goal => (
        <GoalNode
          key={goal.id}
          goal={goal}
          children={noGoals}
          childrenByParent={childrenByParent}
          depth={0}
          goalLink={goalLink}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
