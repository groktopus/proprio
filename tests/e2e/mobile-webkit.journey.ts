import { expect, test, type APIRequestContext } from "@playwright/test";
import { json } from "./http";

async function company(request: APIRequestContext, name: string) {
  const fixture = await json(await request.post("/api/companies", { data: { name } }));
  // A real agent keeps the shell on the ordinary task surface instead of
  // opening the first-agent onboarding overlay over the journey.
  await json(await request.post(`/api/companies/${fixture.id}/agents`, { data: {
    name: "WebKit fixture agent", role: "general", adapterType: "process",
    adapterConfig: { command: "true" },
    runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
  } }));
  return fixture;
}

async function enableMobileTaskUi(request: APIRequestContext) {
  await json(await request.patch("/api/instance/settings/experimental", { data: {
    enableClassicTaskInterface: false,
    enableStreamlinedUi: true,
  } }));
}

test.describe("issue #164 mobile WebKit journeys", () => {
  test("opens and edits the New task dialog", async ({ page, request }) => {
    const fixture = await company(request, "Issue 164 WebKit new task");
    try {
      await enableMobileTaskUi(request);
      await page.goto(`/${fixture.issuePrefix}/dashboard`);
      await page.getByRole("button", { name: /^New task$/i, exact: true }).last().click();

      const editor = page.getByRole("textbox", { name: "editable markdown", exact: true });
      await expect(editor).toBeVisible();
      await expect(editor).toBeFocused();
      await editor.fill("Draft this task on mobile WebKit");
      await expect(editor).toHaveText("Draft this task on mobile WebKit");
      await expect(page.getByRole("button", { name: "Create task", exact: true })).toBeVisible();
    } finally {
      await request.delete(`/api/companies/${fixture.id}`);
    }
  });

  test("keeps the conversation composer usable when the viewport shrinks", async ({ page, request }) => {
    const fixture = await company(request, "Issue 164 WebKit composer");
    const issue = await json(await request.post(`/api/companies/${fixture.id}/issues`, {
      data: { title: "WebKit composer viewport", status: "backlog" },
    }));
    try {
      await enableMobileTaskUi(request);
      await page.goto(`/${fixture.issuePrefix}/issues/${issue.identifier}`);
      const composer = page.getByTestId("task-chat-composer-input");
      const editor = composer.getByRole("textbox", { name: "editable markdown", exact: true });
      await expect(editor).toBeVisible({ timeout: 30_000 });

      await page.evaluate(() => {
        const viewport = window.visualViewport;
        if (!viewport) throw new Error("visualViewport is unavailable");
        Object.defineProperty(viewport, "height", { configurable: true, value: 430 });
        viewport.dispatchEvent(new Event("resize"));
      });
      await editor.fill("Keep the composer reachable while the keyboard is open");
      const viewportHeight = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight);
      const bounds = await composer.boundingBox();
      const send = page.getByTestId("task-chat-composer-send").last();
      const sendBounds = await send.boundingBox();
      expect(bounds).not.toBeNull();
      expect(sendBounds).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewportHeight + 1);
      expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(viewportHeight + 1);
      await expect(editor).toHaveText("Keep the composer reachable while the keyboard is open");
    } finally {
      await request.delete(`/api/companies/${fixture.id}`);
    }
  });

  test("discloses a nested task from the task side panel on a narrow viewport", async ({ page, request }) => {
    const fixture = await company(request, "Issue 164 WebKit nested task");
    const parent = await json(await request.post(`/api/companies/${fixture.id}/issues`, {
      data: { title: "WebKit parent task", status: "backlog" },
    }));
    await json(await request.post(`/api/companies/${fixture.id}/issues`, {
      data: { title: "WebKit nested task", parentId: parent.id, status: "backlog" },
    }));
    try {
      await enableMobileTaskUi(request);
      await page.goto(`/${fixture.issuePrefix}/issues/${parent.identifier}?from=inbox&fromHref=%2Finbox%2Fmine`);
      await page.getByRole("button", { name: "More actions", exact: true }).click();
      await page.getByRole("button", { name: "Properties", exact: true }).click();
      const tasksTab = page.getByRole("option", { name: /Tasks/ });
      await expect(tasksTab).toBeVisible({ timeout: 30_000 });
      await tasksTab.click();
      const child = page.getByRole("link", { name: /WebKit nested task/ });
      await expect(child).toBeVisible();
      const subtasks = page.getByRole("button", { name: "Subtasks", exact: true });
      await subtasks.tap();
      await expect(child).toBeHidden();
      await subtasks.tap();
      await expect(child).toBeVisible();
    } finally {
      await request.delete(`/api/companies/${fixture.id}`);
    }
  });
});
