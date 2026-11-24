import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

const start = process.env.PROPRIO_TASK_OPEN_BUILD;
const output = process.env.PROPRIO_TASK_OPEN_OUTPUT;
const states = ["saved-history", "live-run"] as const;
const entries = ["cold-direct", "uncached-in-app", "cached-return"] as const;

async function readJson(response: APIResponse) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function seed(request: APIRequestContext) {
  const company = await readJson(await request.post("/api/companies", {
    data: { name: `Readiness fixtures ${Date.now()}` },
  }));
  const agent = await readJson(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Long-running test process", role: "engineer", adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => console.log('Synthetic progress'), 2000)"] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    },
  }));
  const tasks = new Map<typeof states[number], { id: string; identifier: string }>();
  for (const state of states) {
    const task = await readJson(await request.post(`/api/companies/${company.id}/issues`, {
      data: { title: `Readiness fixture ${state}`, status: "todo", ...(state === "live-run" ? { assigneeAgentId: agent.id } : {}) },
    }));
    for (const body of ["Saved context for the readiness fixture.", "Latest message in the readiness fixture."]) {
      await readJson(await request.post(`/api/issues/${task.id}/comments`, { data: { body } }));
    }
    tasks.set(state, task);
  }
  return { prefix: company.issuePrefix as string, tasks };
}

test("capture readiness for six release cohorts", async ({ browser, baseURL, request }) => {
  test.skip(!start || !output, "Set exact build and report path for a disposable loopback run");
  if (!/^[0-9a-f]{40}$/.test(start!)) throw new Error("Use the complete Git commit for PROPRIO_TASK_OPEN_BUILD");
  const { prefix, tasks } = await seed(request);
  const live = tasks.get("live-run")!;
  const activePath = `/api/issues/${live.id}/active-run`;
  await expect.poll(async () => (await readJson(await request.get(activePath)))?.status, {
    timeout: 30_000,
  }).toBe("running");
  const run = await readJson(await request.get(activePath));
  const source = await fs.readFile(path.join(import.meta.dirname, "staging-click-harness.js"), "utf8");
  const samples = [];
  try {
    for (const taskKind of states) {
      const task = tasks.get(taskKind)!;
      for (const cohort of entries) for (let index = 1; index <= 5; index += 1) {
        const options = { cohort, taskKind, label: `${cohort} ${taskKind} ${index}`, quietMs: 350, timeoutMs: 10_000 };
        const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
        const page = await context.newPage();
        let measuredPage = page;
        const detail = `/${prefix}/issues/${task.identifier}`;
        const list = `/${prefix}/issues`;
        const row = page.locator(`a[href$="/issues/${task.identifier}"]`).first();
        let sample;
        try {
          if (taskKind === "live-run") {
            expect((await readJson(await request.get(activePath)))?.status).toBe("running");
          }
          if (cohort === "cold-direct") {
            await page.addInitScript({ content: `${source}\nwindow.__cohortResult = window.__taskOpenHarness.measure(${JSON.stringify(task.identifier)}, ${JSON.stringify(options)});` });
            await page.goto(detail, { waitUntil: "domcontentloaded" });
            sample = await page.evaluate("window.__cohortResult");
          } else {
            if (cohort === "cached-return") {
              await page.goto(detail);
              await expect(page.getByText("Latest message in the readiness fixture.", { exact: true }).first()).toBeVisible();
              await page.waitForFunction((id) => Object.entries(localStorage).some(([key, value]) =>
                key.startsWith("proprio:query-cache:v1:") && value.includes(id)), task.id);
              await page.close();
              const revisiting = await context.newPage();
              measuredPage = revisiting;
              await revisiting.goto(list);
              await measure(revisiting);
            } else {
              // Preloading from the list can populate the target before its click.
              // Block only speculative task data until the click begins.
              let clicked = false;
              const taskRoute = /\/api\/(?:issues|companies)\//;
              await page.route(taskRoute, (route) => {
                const url = new URL(route.request().url());
                const targeted = [task.id, task.identifier].some((ref) => url.pathname.includes(`/issues/${ref}`));
                const bootstrap = url.pathname.endsWith("/issues/chat-bootstrap");
                return !clicked && (targeted || bootstrap) ? route.abort() : route.continue();
              });
              await page.goto(list, { waitUntil: "domcontentloaded" });
              await expect(row).toBeVisible();
              const warmTask = await page.evaluate((id) => Object.entries(localStorage).some(([key, value]) =>
                key.startsWith("proprio:query-cache:v1:") && value.includes(id)), task.id);
              expect(warmTask).toBe(false);
              await page.evaluate(source);
              clicked = true;
              await execute(page);
            }
          }
          async function measure(target: Page) {
            await expect(target.locator(`a[href$="/issues/${task.identifier}"]`).first()).toBeVisible();
            await target.evaluate(source);
            await execute(target);
          }
          async function execute(target: Page) {
            sample = await target.evaluate(({ identifier, options }) => {
              const scope = window as unknown as { __taskOpenHarness: { measure: (id: string, options: unknown) => Promise<unknown> } };
              return scope.__taskOpenHarness.measure(identifier, options);
            }, { identifier: task.identifier, options });
          }
          samples.push(sample);
        } catch (error) {
          if (!measuredPage.isClosed()) throw error;
          samples.push({ cohort, taskKind, label: options.label, outcome: "closed" });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await request.post(`/api/heartbeat-runs/${run.id}/cancel`);
  }
  const report = {
    build: {
      commit: start,
      server: `${process.platform} ${process.arch} source checkout ${start}`,
      ui: `Production Vite assets built from ${start}`,
      target: "disposable loopback with embedded PostgreSQL and local process fixture",
      browser: `Playwright Chromium ${browser.version()}`,
      capturedAt: new Date().toISOString(),
    },
    samples,
  };
  await fs.mkdir(path.dirname(output!), { recursive: true });
  await fs.writeFile(output!, JSON.stringify(report, null, 2));
  expect(samples).toHaveLength(30);
});
