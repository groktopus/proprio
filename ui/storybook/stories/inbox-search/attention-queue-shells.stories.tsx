import { useMemo, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { CoordinatorSidebar } from "@/components/CoordinatorSidebar";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { Sidebar as ClassicSidebar } from "@/components/Sidebar.production";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAuthSession } from "../../fixtures/proprioData";

type ShellMode = "classic-desktop" | "coordinator-desktop" | "classic-phone" | "coordinator-phone";

function AttentionQueueShell({ mode }: { mode: ShellMode }) {
  const client = useQueryClient();
  const coordinator = mode.startsWith("coordinator");
  const phone = mode.endsWith("phone");
  useMemo(() => {
    client.setQueryData(queryKeys.auth.session, storybookAuthSession);
    client.setQueryData(queryKeys.instance.experimentalSettings, {
      enableDecisions: true,
      enableStreamlinedUi: !coordinator,
      enableCombinedInboxTasks: false,
    });
    client.setQueryData(queryKeys.workspacePreferences.mine(storybookAuthSession.user!.id), {
      userId: storybookAuthSession.user!.id,
      coordinatorWorkspaceEnabled: coordinator,
    });
  }, [client, coordinator]);

  const shell: ReactNode = phone
    ? <MobileBottomNav visible />
    : coordinator ? <CoordinatorSidebar /> : <ClassicSidebar />;
  return <PluginLauncherProvider><div className={phone ? "min-h-24 bg-background" : "h-[620px] w-72 overflow-hidden bg-background"}>{shell}</div></PluginLauncherProvider>;
}

const meta = {
  id: "attention-queue-shells",
  title: "Tasks and conversations/Inbox, decisions, and search/Attention queue shells",
  component: AttentionQueueShell,
  parameters: {
    layout: "fullscreen",
    proprio: {
      capabilities: ["inbox-search/decisions"],
      implementation: "production",
      boundary: "fixtures",
      notes: "Production Classic, Coordinator, and responsive navigation shells with the Needs You route enabled. Fixture-backed settings and workspace preference choose the real shell; task/source return is covered by the Decisions Desk story.",
    },
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const ClassicDesktop: Story = { args: { mode: "classic-desktop" } };
export const CoordinatorDesktop: Story = { args: { mode: "coordinator-desktop" } };
export const ClassicPhone: Story = { args: { mode: "classic-phone" } };
export const CoordinatorPhone: Story = { args: { mode: "coordinator-phone" } };
