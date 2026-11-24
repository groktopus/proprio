import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

export const durableTaskReadbackTitle = "the recovered task output remains visible after browser reload";

export async function verifyRecoveredTaskReadback({ origin, issuePrefix, identifier, title, output, reportPath }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const route = `/${issuePrefix}/issues/${identifier}`;
    const assertReadback = async () => {
      await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible", timeout: 30_000 });
      await page.getByText(output, { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    };
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await assertReadback();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await assertReadback();
    assert.equal(new URL(page.url()).pathname, route);
    const report = {
      suites: [{ specs: [{ title: durableTaskReadbackTitle, tests: [{ results: [{ status: "passed" }] }] }] }],
      recoveredTask: { title, output, route, reloads: 1 },
    };
    if (reportPath) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, issuePrefix, identifier, title, output] = process.argv.slice(2);
  assert.ok(origin && issuePrefix && identifier && title && output, "Expected origin, issue prefix, identifier, title, and output");
  const report = await verifyRecoveredTaskReadback({
    origin, issuePrefix, identifier, title, output, reportPath: process.env.E2E_UPDATE_BROWSER_REPORT,
  });
  console.log(`PASS browser-task-readback — ${report.recoveredTask.route} survived one reload.`);
}
