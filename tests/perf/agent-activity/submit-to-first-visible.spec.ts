import fs from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * Browser cross-check for the run-log proxy used by the native baseline.
 *
 * This is opt-in because it needs an authenticated, already-seeded checkout:
 *   PROPRIO_PERF_BASE_URL=http://127.0.0.1:3100 \
 *   PROPRIO_PERF_STORAGE_STATE=/path/to/auth.json \
 *   PROPRIO_PERF_ISSUE_PATH=/ACME/issues/... \
 *   pnpm exec playwright test --config tests/perf/agent-activity/playwright.config.ts
 *
 * The first new task-chat row is a UI visibility proxy, not proof of provider
 * activity. The report must compare it with the server trace separately.
 */
test("cross-checks first visible task-chat activity after submit", async ({ page }, testInfo) => {
  const issuePath = process.env.PROPRIO_PERF_ISSUE_PATH;
  test.skip(!issuePath, "set PROPRIO_PERF_ISSUE_PATH for an authenticated seeded task");
  const marker = `latency-cross-check-${Date.now().toString(36)}`;
  await page.goto(issuePath!);
  const rows = page.locator('[data-conversation-message="agent"]');
  const before = await rows.count();
  const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]').last();
  await expect(editor).toBeVisible();
  await editor.fill(marker);
  const submittedAtMs = Date.now();
  await page.getByTestId("task-chat-composer-send").click();
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(before);
  const visibleAtMs = Date.now();
  const issueRef = issuePath!.split("/").filter(Boolean).at(-1)!;
  let run: { id?: string; runId?: string; createdAt?: string } | undefined;
  for (let attempt = 0; attempt < 30 && !run; attempt += 1) {
    const runs = await page.evaluate(async (ref) => {
      const response = await fetch(`/api/issues/${encodeURIComponent(ref)}/runs`);
      return response.ok ? await response.json() as Array<{ id?: string; runId?: string; createdAt?: string }> : [];
    }, issueRef);
    run = runs
      .filter(candidate => candidate.createdAt && Date.parse(candidate.createdAt) >= submittedAtMs - 5_000)
      .sort((a, b) => Date.parse(a.createdAt!) - Date.parse(b.createdAt!))[0];
    if (!run) await page.waitForTimeout(500);
  }
  await fs.writeFile(
    testInfo.outputPath("browser-first-visible-activity.json"),
    `${JSON.stringify({
      issuePath,
      marker,
      submittedAtMs,
      visibleAtMs,
      runId: run?.runId ?? run?.id ?? null,
      browserSubmitToFirstNewRowMs: visibleAtMs - submittedAtMs,
      proxy: "first_new_agent_conversation_message",
    }, null, 2)}\n`,
  );
});
