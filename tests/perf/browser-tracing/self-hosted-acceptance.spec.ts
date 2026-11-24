import fs from "node:fs/promises";
import { expect, request as pwRequest, test, type APIRequestContext, type Page } from "@playwright/test";

const mode = process.env.PROPRIO_BROWSER_TRACING_MODE ?? "enabled";
const collectorPort = Number(process.env.PROPRIO_BROWSER_TRACING_COLLECTOR_PORT ?? 3238);
const collectorUrl = `http://127.0.0.1:${collectorPort}/v1/traces`;

type Company = { id: string; issuePrefix: string };
type Issue = { id: string; identifier: string };

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>> | Awaited<ReturnType<APIRequestContext["post"]>>): Promise<T> {
  if (!response.ok()) throw new Error(`HTTP ${response.url()} -> ${response.status()}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function seed(request: APIRequestContext): Promise<{ company: Company; task: Issue }> {
  const company = await json<Company>(await request.post("/api/companies", { data: { name: `Browser traces ${Date.now()}` } }));
  await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: { name: "Browser trace fixture", role: "ceo", adapterType: "process", adapterConfig: { command: "true" } },
  }));
  const task = await json<Issue>(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "PRIVATE_BROWSER_TRACE_TASK_CONTENT", status: "todo" },
  }));
  return { company, task };
}

function sdkRequest(url: string): boolean {
  return /(?:browser-tracing|sdk)-[A-Za-z0-9_-]+\.js(?:\?|$)/.test(url);
}

function traceSpans(bodies: string[]): Array<Record<string, unknown>> {
  return bodies.flatMap((body) => {
    const payload = JSON.parse(body) as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }> };
    return payload.resourceSpans?.flatMap((resource) => resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? []) ?? [];
  });
}

test.describe("self-hosted browser tracing on Linux", () => {
  test("proves opt-in, sampling, sink failure, redaction, and task-list/detail samples", async ({ page, request }, testInfo) => {
    const session = await json<{
      session: { id: string; userId: string };
      user: { id: string };
      browserTracing: Record<string, unknown> | null;
    }>(await request.get("/api/auth/get-session"));
    expect(session.session).toEqual(expect.objectContaining({ id: expect.any(String), userId: expect.any(String) }));
    expect(session.user).toEqual(expect.objectContaining({ id: session.session.userId }));
    const traceBodies: string[] = [];
    const tracePosts: string[] = [];
    const sdkLoads: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (requestEvent) => {
      if (requestEvent.resourceType() === "script" && sdkRequest(requestEvent.url())) sdkLoads.push(requestEvent.url());
    });
    await page.route(collectorUrl, async (route) => {
      tracePosts.push(route.request().url());
      traceBodies.push(route.request().postData() ?? "");
      await route.fulfill({
        status: mode === "sink-failure" ? 503 : 200,
        contentType: "application/json",
        body: "{}",
      });
    });

    const fixture = await seed(request);
    if (mode === "disabled") expect(session.browserTracing).toBeNull();
    else expect(session.browserTracing).toEqual(expect.objectContaining({ tracesUrl: collectorUrl }));
    if (mode === "unsampled") {
      await page.addInitScript(() => { Math.random = () => 0.99; });
    }
    await page.goto(`/${fixture.company.issuePrefix}/issues`);
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
    await expect(page.getByText("PRIVATE_BROWSER_TRACE_TASK_CONTENT", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "New task" }).first()).toBeVisible();
    await page.getByRole("button", { name: "New task" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Create task" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(2_000);
    await page.goto(`/${fixture.company.issuePrefix}/issues/${fixture.task.identifier}`);
    await expect(page.getByRole("button", { name: "Open account menu" })).toBeVisible();
    await expect(page.getByText("PRIVATE_BROWSER_TRACE_TASK_CONTENT", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(2_000);

    if (mode === "disabled" || mode === "unsampled") {
      expect(sdkLoads).toHaveLength(0);
      expect(tracePosts).toHaveLength(0);
    } else {
      expect(sdkLoads.length).toBeGreaterThan(0);
      if (mode === "enabled" || mode === "sink-failure") expect(tracePosts.length).toBeGreaterThan(0);
      const spans = traceSpans(traceBodies);
      if (mode !== "unsampled") {
        expect(spans.filter((span) => span.name === "page.load").map((span) => JSON.stringify(span))).toEqual(expect.arrayContaining([
          expect.stringContaining("/:companyPrefix/issues"),
          expect.stringContaining("/:companyPrefix/issues/:issueId"),
        ]));
      }
      const serialized = traceBodies.join("\n");
      expect(serialized).not.toContain("PRIVATE_BROWSER_TRACE_TASK_CONTENT");
      expect(serialized).not.toContain(fixture.task.identifier);
      expect(serialized).not.toContain(fixture.company.id);
    }
    if (mode === "sink-failure") {
      expect(pageErrors).toEqual([]);
    }
    const evidence = {
      build: process.env.PROPRIO_BROWSER_TRACING_BUILD_ID ?? "unknown",
      mode,
      sampleCount: traceSpans(traceBodies).filter((span) => span.name === "page.load").length,
      tracePosts: tracePosts.length,
      sdkLoads: sdkLoads.length,
      pageErrors,
      routes: traceSpans(traceBodies).filter((span) => span.name === "page.load").map((span) => span.attributes),
    };
    const evidencePath = testInfo.outputPath(`browser-tracing-${mode}.json`);
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await testInfo.attach("browser-tracing-acceptance", {
      path: evidencePath,
      contentType: "application/json",
    });
  });
});
