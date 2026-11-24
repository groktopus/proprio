import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, type Page } from "@playwright/test";

const require = createRequire(import.meta.url);
const addon = require.resolve("@storybook/addon-a11y/package.json", {
  paths: [resolve(import.meta.dirname, "../../ui")],
});
const axePath = require.resolve("axe-core/axe.min.js", { paths: [addon] });

type Violation = {
  id: string;
  impact: string | null;
  nodes: { target: string[]; failureSummary?: string }[];
};

export async function scanStoryAccessibility(page: Page, include: string[]) {
  await page.evaluate(() => document.fonts.ready);
  await page.addScriptTag({ path: axePath });
  let violations: Violation[] | null = null;
  await expect.poll(async () => {
    violations = await page.evaluate(async (include) => {
      const { axe } = window as Window & {
        axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Violation[] }> };
      };
      try {
        const result = await axe.run({ include }, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        });
        return result.violations.map(({ id, impact, nodes }) => ({
          id,
          impact,
          nodes: nodes.map(({ target, failureSummary }) => ({ target, failureSummary })),
        }));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Axe is already running")) return null;
        throw error;
      }
    }, include);
    return violations !== null;
  }, { message: "Wait for the Storybook axe scan" }).toBe(true);
  return violations;
}
