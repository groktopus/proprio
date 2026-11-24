import { expect, test } from "@playwright/test";

const cases = [
  { name: "find-pending-request", story: "pages-decisions-views--for-you", width: 1200, height: 800 },
  { name: "read-request-context", story: "decisions-decisioncard--pending-with-input", width: 1200, height: 800 },
  { name: "partial-result", story: "decisions-decisioncard--partial", width: 1200, height: 800 },
  { name: "pending-phone-question", story: "composer-interaction-above-composer--mobile-detailed-questions-with-bottom-bar", width: 390, height: 844 },
];

for (const specimen of cases) for (const theme of ["light", "dark"]) {
  test(`${specimen.name} in ${theme}`, async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    await page.route(/^https?:\/\//, route => (
      new URL(route.request().url()).origin === origin ? route.fallback() : route.abort()
    ));
    await page.clock.setFixedTime(new Date("2026-07-23T12:00:00Z"));
    await page.setViewportSize({ width: specimen.width, height: specimen.height });
    await page.goto(`/iframe.html?id=${specimen.story}&viewMode=story&globals=theme:${theme}`);
    const story = page.locator("#storybook-root");
    await expect(story).not.toBeEmpty();
    await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
    if (specimen.name === "find-pending-request") {
      await expect(story.getByRole("heading", { name: "Decisions" })).toBeVisible();
      await expect(story.getByText("Which rollout order should we use?")).toBeVisible();
    } else if (specimen.name === "read-request-context") {
      await expect(story.getByRole("textbox", { name: /Reassignment note/ })).toBeVisible();
    } else if (specimen.name === "partial-result") {
      await expect(story.getByText("Commented on PAP-456")).toBeVisible();
      await expect(story.getByText(/Failed on PAP-456|blocked by the permission boundary/)).toBeVisible();
    } else {
      await expect(story.getByRole("radio", { name: /Only collapse hidden descendants/ })).toBeVisible();
      await expect(story.getByRole("button", { name: "Send answers" })).toBeVisible();
      await expect(page.getByTestId("task-chat-composer-takeover")).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    }
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`operator-attention-${specimen.name}-${theme}.png`);
  });
}
