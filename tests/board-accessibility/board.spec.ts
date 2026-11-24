import { expect, test, type Page } from "@playwright/test";
import { scanStoryAccessibility } from "../storybook-visual/axe-scan";

async function openStory(page: Page, story: string, theme = "light") {
  await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:${theme}`);
  await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: 30_000 });
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
}

async function expectAccessible(page: Page, story: string, selector: string) {
  await expect(page.locator(selector).first()).toBeVisible();
  expect(await scanStoryAccessibility(page, [selector]), `${story} (${selector})`).toEqual([]);
}

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    return route.abort();
  });
});

test("shell account overlay moves focus in and returns it on Escape", async ({ page }) => {
  const story = "product-navigation-layout--account-popover-browser";
  await openStory(page, story);
  const trigger = page.getByRole("button", { name: "Open account menu" });
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect.poll(() => dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expectAccessible(page, story, "[role=dialog]");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("task list links have names and can receive keyboard focus", async ({ page }) => {
  const story = "product-issue-management--agent-created-tasks-hidden";
  await openStory(page, story);
  const row = page.getByRole("link", { name: /open .*:/i }).first();
  await expect(row).toBeVisible();
  await page.getByRole("button", { name: "Filter", exact: true }).focus();
  for (let tab = 0; tab < 20; tab += 1) {
    await page.keyboard.press("Tab");
    if (await row.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(row).toBeFocused();
  await expectAccessible(page, story, "#storybook-root");
});

test("a task can move on the board by keyboard", async ({ page }) => {
  const story = "product-data-visualization-misc--kanban-board-populated";
  await openStory(page, story);
  const task = "Sketch company analytics dashboard";
  const status = page.getByRole("combobox", { name: `Change status for ${task}` });
  await expect(status).toHaveValue("backlog");
  await expectAccessible(page, story, "#storybook-root");
  const move = page.getByRole("button", { name: `Move task ${task}` });
  await move.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect(status).toHaveValue("todo");
  await expect(page.getByRole("status").filter({ hasText: `${task} moved to` })).toBeAttached();
  await expect(move).toBeFocused();
});

test("narrow New task dialog supports keyboard editor input and dismissal", async ({ page }) => {
  const story = "product-dialogs-modals--new-issue-keyboard";
  await page.setViewportSize({ width: 390, height: 844 });
  await openStory(page, story);
  const opener = page.getByRole("button", { name: "New task", exact: true });
  await opener.press("Enter");
  const dialog = page.getByRole("dialog", { name: "New task" });
  const editor = dialog.locator("[contenteditable=true]");
  await expect(editor).toBeFocused();
  await expectAccessible(page, story, "[role=dialog]");
  await page.keyboard.insertText("Review the board");
  await expect(editor).toContainText("Review the board");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the saved task title can be edited with a keyboard", async ({ page }) => {
  const story = "tasks-monitoring-status--task-detail-keyboard-editing";
  await openStory(page, story);
  const original = page.getByRole("button", { name: "Verify deployment after CI completes", exact: true });
  await expect(original).toBeVisible();
  await original.press("Enter");
  const editor = page.getByRole("textbox", { name: "Click to edit..." });
  await expect(editor).toBeFocused();
  await expectAccessible(page, story, "textarea[aria-label='Click to edit...']");
  await page.keyboard.insertText("Verify release recovery");
  await page.keyboard.press("Enter");
  const saved = page.getByRole("button", { name: "Verify release recovery", exact: true });
  await expect(saved).toBeFocused();
});

test("Inbox marks its current link and exposes retry after a failed read", async ({ page }) => {
  const story = "feature-inbox-views--recoverable";
  await openStory(page, story, "dark");
  const nav = page.getByRole("navigation", { name: "Inbox views" });
  await expect(nav.getByRole("link", { name: "Unread" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page, story, "#storybook-root");
  const retry = page.getByRole("alert").getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("storybook:restore-inbox-read")));
  await retry.press("Enter");
  await expect(retry).toBeHidden();
  await expect(page.locator("[data-inbox-item]").first()).toBeVisible();
});
