import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const ui = resolve(import.meta.dirname, "../../ui");
const addon = require.resolve("@storybook/addon-a11y/package.json", { paths: [ui] });
const axeScript = require.resolve("axe-core/axe.min.js", { paths: [addon] });

type AxeResult = {
  violations: { id: string; nodes: { target: string[]; failureSummary?: string }[] }[];
};

async function openStory(page: Page, story: string, theme = "light") {
  await page.goto(`/iframe.html?id=${story}&viewMode=story&globals=theme:${theme}`);
  await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: 30_000 });
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible();
}

async function expectAccessible(page: Page, story: string, selector: string) {
  await expect(page.locator(selector).first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: axeScript });
  let violations: AxeResult["violations"] | null = null;
  await expect.poll(async () => {
    violations = await page.evaluate(async (selector) => {
      const axe = (window as Window & {
        axe: { run: (context: unknown, options: unknown) => Promise<AxeResult> };
      }).axe;
      try {
        const { violations } = await axe.run({ include: [selector] }, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        });
        return violations.map(({ id, nodes }) => ({
          id,
          nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
        }));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Axe is already running")) return null;
        throw error;
      }
    }, selector);
    return violations !== null;
  }, { message: `Wait for axe to scan ${story}` }).toBe(true);
  expect(violations, `${story} (${selector})`).toEqual([]);
}

test.beforeEach(async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  await page.route(/^https?:\/\//, (route) => {
    if (new URL(route.request().url()).origin === origin) return route.fallback();
    return route.abort();
  });
});

test("shell account overlay moves focus in and returns it on Escape", async ({ page }) => {
  const story = "product-navigation-layout--account-popover";
  await openStory(page, story);
  await expect(page.locator("[data-navigation-overlay-verified=true]")).toBeVisible();
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
  await row.focus();
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
  await page.getByRole("button", { name: "New task", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "New task" });
  const editor = dialog.locator("[contenteditable=true]");
  await expect(editor).toBeFocused();
  await expectAccessible(page, story, "[role=dialog]");
  await page.keyboard.insertText("Review the board");
  await expect(editor).toContainText("Review the board");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Inbox marks its current link and exposes retry after a failed read", async ({ page }) => {
  const story = "feature-inbox-views--recoverable";
  await openStory(page, story, "dark");
  const nav = page.getByRole("navigation", { name: "Inbox views" });
  await expect(nav.getByRole("link", { name: "Unread" })).toHaveAttribute("aria-current", "page");
  await expectAccessible(page, story, "#storybook-root");
  const retry = page.getByRole("alert").getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await page.evaluate(() => sessionStorage.setItem("storybook.inbox-fixture-recovered", "true"));
  await retry.press("Enter");
  await expect(retry).toBeHidden();
  await expect(page.locator("[data-inbox-item]").first()).toBeVisible();
});
