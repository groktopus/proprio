import { useLayoutEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { GitHubNativeGrantSummary } from "@groktopus/shared";
import { GitHubNativeGitSetup } from "@/pages/apps/GitHubNativeGitSetup";

const companyId = "a2e23ee5-f083-409c-9a9d-d8bc2bcdef42";
const agentId = "9fa7c563-b595-4286-8954-37fcd61cf302";
const path = `/api/companies/${companyId}/github-native-git`;

function TerminalGitFixture() {
  const [ready, setReady] = useState(false);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  useLayoutEffect(() => {
    const original = window.fetch;
    let failVerification = true;
    let grant: GitHubNativeGrantSummary | null = null;
    const mock: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const requestPath = new URL(url, window.location.origin).pathname;
      if (requestPath === `/api/companies/${companyId}/agents`) {
        return Response.json([{ id: agentId, name: "Release engineer", adapterType: "proprio_runner", status: "active" }]);
      }
      if (requestPath === `${path}/eligible-agents`) return Response.json([agentId]);
      if (requestPath === path && init?.method === "POST") {
        if (failVerification) {
          failVerification = false;
          return Response.json({ error: "GitHub did not verify this installation. Check the repository access and retry." }, { status: 422 });
        }
        grant = { id: "17df0faf-0b3d-42af-8e1c-f1c92d4d6037", agentId, repository: "example/release",
          appSlug: "release-app", push: true, pullRequests: true, verifiedAt: "2026-01-01T00:00:00Z", revokedAt: null };
        return Response.json(grant);
      }
      if (grant && requestPath === `${path}/${grant.id}` && init?.method === "DELETE") {
        grant = { ...grant, revokedAt: "2026-01-02T00:00:00Z" };
        return Response.json(grant);
      }
      if (requestPath === path) return Response.json(grant ? [grant] : []);
      return original(input, init);
    };
    window.fetch = mock;
    setReady(true);
    return () => { if (window.fetch === mock) window.fetch = original; client.clear(); };
  }, [client]);
  return <QueryClientProvider client={client}>
    {ready && <GitHubNativeGitSetup companyId={companyId} />}
  </QueryClientProvider>;
}

const meta = {
  id: "connection-setup-github-terminal-git",
  title: "Apps, channels, and extensions/Connection setup/GitHub terminal Git",
  component: TerminalGitFixture,
  parameters: { proprio: {
    capabilities: ["connection-setup/credentials", "connection-setup/failure", "connection-setup/identity-and-access"],
    status: "current",
    implementation: "production",
    boundary: "fixtures",
    notes: "The production form loads an eligible agent, retries a failed verification, and revokes a saved grant. GitHub and secret persistence are simulated.",
  } },
} satisfies Meta<typeof TerminalGitFixture>;
export default meta;

export const Setup: StoryObj<typeof meta> = {};

export const RetryAndRevoke: StoryObj<typeof meta> = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(await canvas.findByLabelText("Agent"), agentId);
    await userEvent.type(canvas.getByLabelText("Repository"), "example/release");
    await userEvent.type(canvas.getByLabelText("GitHub App ID"), "123");
    await userEvent.click(canvas.getByLabelText("Push branches"));
    await userEvent.click(canvas.getByLabelText("Open pull requests"));
    const submit = canvas.getByRole("button", { name: "Verify and save grant" });
    await userEvent.type(canvas.getByLabelText("App private key (PEM)"), "fixture-key");
    await userEvent.click(submit);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("GitHub did not verify this installation");
    await userEvent.type(canvas.getByLabelText("App private key (PEM)"), "fixture-key");
    await userEvent.click(submit);
    await userEvent.click(await canvas.findByRole("button", { name: "Revoke" }));
    await expect(await canvas.findByText("release-app · Revoked")).toBeVisible();
  },
};
