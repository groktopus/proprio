import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";

const build = process.env.PROPRIO_AGENT_ACTIVITY_BUILD;
const output = process.env.PROPRIO_AGENT_ACTIVITY_OUTPUT;

type Fixture = { prefix: string; issue: { id: string; identifier: string }; runId: string };

async function json(response: APIResponse): Promise<any> {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function seed(request: APIRequestContext): Promise<Fixture> {
  const company = await json(await request.post("/api/companies", {
    data: { name: `Credential-free activity ${Date.now()}` },
  }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Credential-free process fixture",
      role: "engineer",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", [
        "const run=process.env.PROPRIO_RUN_ID;",
        "const api=process.env.PROPRIO_API_URL;",
        "const headers={Authorization:'Bearer '+process.env.PROPRIO_API_KEY,'X-Proprio-Run-Id':run,'Content-Type':'application/json'};",
        "setTimeout(async()=>{const runResponse=await fetch(api+'/api/heartbeat-runs/'+run,{headers}); if(!runResponse.ok) throw new Error('run lookup failed: '+runResponse.status); const issueId=(await runResponse.json()).contextSnapshot?.issueId; if(!issueId) throw new Error('run context has no issue'); const response=await fetch(api+'/api/issues/'+issueId+'/comments',{method:'POST',headers,body:JSON.stringify({body:'Synthetic agent activity '+run})}); if(!response.ok) throw new Error('synthetic comment failed: '+response.status);},1000);",
        "setTimeout(()=>process.exit(0),12000);",
      ].join(" ")] },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    },
  }));
  const issue = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Credential-free activity fixture", status: "todo", assigneeAgentId: agent.id },
  }));
  await json(await request.post(`/api/issues/${issue.id}/comments`, {
    data: { body: "Start the disposable process fixture.", clientRequestId: crypto.randomUUID() },
  }));
  await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/active-run`)))?.status, { timeout: 30_000 }).toBe("running");
  const active = await json(await request.get(`/api/issues/${issue.id}/active-run`));
  expect(active.status).toBe("running");
  return { prefix: company.issuePrefix as string, issue, runId: active.id as string };
}

test("compares persisted queue activity with first visible agent activity", async ({ page, request }, testInfo) => {
  test.skip(!build || !output, "Set PROPRIO_AGENT_ACTIVITY_BUILD and PROPRIO_AGENT_ACTIVITY_OUTPUT for a disposable loopback run");
  if (!/^[0-9a-f]{40}$/.test(build!)) throw new Error("Use the complete Git commit for PROPRIO_AGENT_ACTIVITY_BUILD");
  const fixture = await seed(request);
  const marker = `credential-free-queue-${Date.now().toString(36)}`;
  const markerHash = crypto.createHash("sha256").update(marker).digest("hex");
  const detailPath = `/${fixture.prefix}/issues/${fixture.issue.identifier}`;
  await page.goto(detailPath, { waitUntil: "domcontentloaded" });
  const rows = page.locator('[data-conversation-message="agent"]');
  const editor = page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]').last();
  await expect(editor).toBeVisible();
  await expect.poll(async () => {
    const active = await json(await request.get(`/api/issues/${fixture.issue.id}/active-run`));
    return active?.status === "running" && active.id === fixture.runId;
  }, { timeout: 15_000 }).toBe(true);
  await editor.fill(marker);
  const clickedAtMs = Date.now();
  const acceptedResponse = page.waitForResponse(response => {
    if (response.request().method() !== "POST") return false;
    const pathname = new URL(response.url()).pathname;
    return pathname === `/api/issues/${fixture.issue.id}/comments` || pathname === `/api/issues/${fixture.issue.identifier}/comments`;
  }, { timeout: 30_000 });
  await page.getByTestId("task-chat-composer-send").click();
  const accepted = await acceptedResponse;
  const acceptedComment = await json(accepted);
  const acceptedResponseReceivedAtMs = Date.now();
  await expect.poll(async () => {
    const comments = await json(await request.get(`/api/issues/${fixture.issue.id}/comments?order=asc`));
    return Array.isArray(comments) && comments.some(comment => comment.id === acceptedComment.id && comment.body === marker);
  }, { timeout: 30_000 }).toBe(true);
  let followUp: { id: string } | null = null;
  await expect.poll(async () => {
    const active = await json(await request.get(`/api/issues/${fixture.issue.id}/active-run`));
    followUp = active?.status === "running" && active.id !== fixture.runId ? { id: active.id } : null;
    return followUp !== null;
  }, { timeout: 30_000 }).toBe(true);
  const syntheticBody = `Synthetic agent activity ${followUp!.id}`;
  let persisted: { id: string; createdAt: string; createdByRunId?: string; body: string } | null = null;
  await expect.poll(async () => {
    const comments = await json(await request.get(`/api/issues/${fixture.issue.id}/comments?order=asc`));
    persisted = Array.isArray(comments)
      ? comments.find(comment => comment.body === syntheticBody && comment.createdByRunId === followUp!.id) ?? null
      : null;
    return persisted !== null;
  }, { timeout: 30_000 }).toBe(true);
  const targetRow = rows.filter({ hasText: syntheticBody });
  await expect(targetRow).toBeVisible({ timeout: 30_000 });
  const browserVisibleAtMs = Date.now();
  const persistedAtServerMs = Date.parse(persisted!.createdAt);

  const report = {
    build: { commit: build, target: "disposable loopback with embedded database and local process adapter", capturedAt: new Date().toISOString() },
    browser: { engine: "Playwright Chromium", visibleSelector: '[data-conversation-message="agent"]' },
    input: { clickedAtMs, acceptedResponseReceivedAtMs, acceptedAtServerMs: Date.parse(acceptedComment.createdAt), markerSha256: markerHash, initialRunId: fixture.runId, followUpRunId: followUp!.id },
    persistedActivity: { createdAt: persisted!.createdAt, commentId: persisted!.id, createdByRunId: persisted!.createdByRunId },
    browserVisibleAtMs,
    browserClickToFirstVisibleSyntheticAgentCommentMs: browserVisibleAtMs - clickedAtMs,
    serverAcceptedToPersistedSyntheticAgentCommentMs: persistedAtServerMs - Date.parse(acceptedComment.createdAt),
    evidenceBoundary: "credential-free local process fixture; not provider or release performance evidence",
  };
  await fs.mkdir(path.dirname(output!), { recursive: true });
  await fs.writeFile(output!, `${JSON.stringify(report, null, 2)}\n`);
});
