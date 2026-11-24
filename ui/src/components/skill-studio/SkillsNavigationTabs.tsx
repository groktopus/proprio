import type { ReactNode } from "react";
import { RouteTabBar } from "../RouteTabBar";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { SKILLS_NAVIGATION_HREFS, type SkillsNavigationView } from "@/pages/skills/skills-navigation";

const views = [
  { value: "installed", label: "Installed" },
  { value: "discover", label: "Discover" },
  { value: "authored", label: "My Skills" },
] as const;

/** Route navigation with the canonical tab appearance. Sources stays in the actions menu. */
export function SkillsNavigationTabs({ activeView }: { activeView: SkillsNavigationView }) {
  return <RouteTabBar label="Skills views" current={SKILLS_NAVIGATION_HREFS[activeView]}
    items={views.map((view) => ({ href: SKILLS_NAVIGATION_HREFS[view.value], label: view.label }))} />;
}

/** Standalone Skills pages share navigation beneath their own header controls. */
export function SkillsPageNavigation({ activeView, fallback = null }: { activeView: SkillsNavigationView; fallback?: ReactNode }) {
  const { enabled } = useStreamlinedUiEnabled();
  return enabled ? <div className="shrink-0 border-b border-border px-3 py-2"><SkillsNavigationTabs activeView={activeView} /></div> : fallback;
}
