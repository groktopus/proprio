import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentProps } from "react";
import { useEffect, useRef } from "react";
import { Inbox } from "@/pages/Inbox";
import { useNavigate } from "@/lib/router";
import { instanceExperimentalSettingsSchema } from "@groktopus/shared";
import { storybookIssues } from "../../fixtures/proprioData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function InboxHost(props: NonNullable<ComponentProps<typeof Inbox>>) {
  const { tab: initialTab = "mine", ...inboxProps } = props;
  const navigate = useNavigate();
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    navigate(`/inbox/${initialTab}`, { replace: true });
  }, [initialTab, navigate]);

  // Route changes are the source of truth after the initial story seed. Do not
  // pass the story arg back as an Inbox override, or links appear to navigate
  // while the rendered view remains on the original story tab.
  return <Inbox {...inboxProps} />;
}
const meta = {
  id: "feature-inbox-views",
  title:
    "Tasks and conversations/Inbox, decisions, and search/Personal task views",
  component: InboxHost,
  args: { tab: "mine" },
  parameters: { layout: "padded",
    proprio: {
      "capabilities": [
        "inbox-search/views"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Shipped Inbox host with Mine/Recent/Unread/Blocked under combined-inbox flags and list states. Approvals/join requests/run lists are isolated alongside tasks. Failed/denied list queries currently fall back to Inbox zero; personal participation/read metadata and server counts remain production verification. Mine/recent fixture tasks are human-created; the upstream agent-created-task filter changes are separate visibility scenarios."
    },
  },
  beforeEach: ({ parameters }) => {
    let recovered = false;
    const recover = () => { recovered = true; };
    if (parameters.recoveryFixture) window.addEventListener("storybook:restore-inbox-read", recover);
    const api = prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/issues",
          read: () => {
            if (parameters.recoveryFixture && !recovered) {
              return Response.json({ error: "Fixture read unavailable" }, { status: 500 });
            }
            return parameters.fixtureState === "empty" ? [] : storybookIssues;
          },
        },
        {
          path: /^\/api\/companies\/company-storybook\/(approvals|join-requests|heartbeat-runs)$/,
          read: () => [],
        },
      ],
      parameters.fixtureState as FixtureState,
    );
    const flags = prepareFixtureApi([
      {
        path: "/api/instance/settings/experimental",
        read: () => ({
          ...instanceExperimentalSettingsSchema.parse({}),
          enableStreamlinedUi: true,
          enableCombinedInboxTasks: true,
        }),
      },
    ]);
    return () => {
      window.removeEventListener("storybook:restore-inbox-read", recover);
      flags.cleanup();
      api.cleanup();
    };
  },
} satisfies Meta<typeof InboxHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Mine: Story = { args: { tab: "mine" } };
export const Recent: Story = { args: { tab: "recent" } };
export const Unread: Story = { args: { tab: "unread" } };
export const Blocked: Story = { args: { tab: "blocked" } };
export const Empty: Story = {
  args: { tab: "mine" },
  parameters: { fixtureState: "empty" },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = { parameters: { fixtureState: "failure" } };
export const Recoverable: Story = {
  args: { tab: "unread" },
  parameters: { recoveryFixture: true },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
