import { expect, test, type Page } from "@playwright/test";

const navigationStory = "product-navigation-layout--board-chrome-matrix";
const queueStory = "pages-decisions-desk--todays-desk";

async function openStory(page: Page, story: string, width: number, coordinator: boolean) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.route("**/api/workspace-preferences/me", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ userId: "user-board", coordinatorWorkspaceEnabled: coordinator }),
  }));
  await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:light`, { waitUntil: "load" });
  await expect(page.locator(".sb-show-errordisplay")).toHaveCount(0);
  await expect(page.locator("#storybook-root")).not.toBeEmpty();
}

for (const scenario of [
  { name: "Classic desktop", width: 1440, coordinator: false },
  { name: "Coordinator desktop", width: 1440, coordinator: true },
  { name: "Classic phone", width: 390, coordinator: false },
  { name: "Coordinator phone", width: 390, coordinator: true },
] as const) {
  test(`${scenario.name} exposes the Needs You request entry`, async ({ page }) => {
    await openStory(page, navigationStory, scenario.width, scenario.coordinator);
    const needsYou = page.getByRole("link", { name: /Needs You/ }).first();
    await expect(needsYou).toBeVisible();
    await expect(needsYou).toHaveAttribute("href", "/decisions");
  });
}

test("fixture-backed request exposes a followable source task and returns to the queue", async ({ page }) => {
  await openStory(page, queueStory, 1440, true);
  const sourceTask = page.locator('a[href^="/issues/"]').first();
  await expect(sourceTask).toBeVisible();
  const href = await sourceTask.getAttribute("href");
  expect(href).toMatch(/^\/issues\//);
  await sourceTask.click();
  await expect.poll(() => page.evaluate(() => window.location.pathname)).toContain("/issues/");
  await page.goBack();
  await expect(page.getByText(/Decide now|New today|Earlier/).first()).toBeVisible();
});
