import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const [role, configPath] = process.argv.slice(2);
let config;
const configDeadline = Date.now() + 10_000;
while (!config && Date.now() < configDeadline) {
  config = await readFile(configPath, "utf8").catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!config) await setTimeout(50);
}
if (!config) throw new Error("Timed out waiting for the Case fixture IDs");
const { taskId, caseId, builderId, builderInstructions, sourceReceipt, releaseFile, verificationReceipt } = JSON.parse(config);
const runId = process.env.PROPRIO_RUN_ID;
const headers = { authorization: `Bearer ${process.env.PROPRIO_API_KEY}`, "x-proprio-run-id": runId,
  "content-type": "application/json" };
async function api(path, method = "GET", body, expected) {
  const response = await fetch(`${process.env.PROPRIO_API_URL}/api${path}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  if (expected === undefined ? !response.ok : ![].concat(expected).includes(response.status)) {
    throw new Error(`${method} ${path}: ${response.status} ${raw}`);
  }
  return raw ? JSON.parse(raw) : null;
}

const work = await api(`/cases/${caseId}`);
if (work.workIssueId !== taskId) throw new Error("The Case changed tasks");
if (role === "lead") {
  const request = { idempotencyKey: "mixed-handoff-lead", case: { id: caseId }, toAgentId: builderId,
    phase: "implementation", instructions: builderInstructions,
    expectedHandoffVersion: work.handoffVersion, expectedIssueStatusVersion: work.workIssue.statusVersion };
  const handoffPath = `/companies/${process.env.PROPRIO_COMPANY_ID}/case-handoffs`;
  const handoff = await api(handoffPath, "POST", request, 202);
  const replay = await api(handoffPath, "POST", request, 200);
  if (handoff.handoffId !== replay.handoffId || !handoff.callerMustYield) throw new Error("Invalid handoff replay");
  const staleWrite = await api(`/issues/${taskId}`, "PATCH", { title: "Stale executor changed this title" }, [403, 409]);
  await writeFile(sourceReceipt, JSON.stringify({ handoffId: handoff.handoffId, handoffVersion: handoff.handoffVersion, runId,
    staleWriteCode: staleWrite.code ?? staleWrite.details?.code }), { flag: "wx" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await readFile(releaseFile, "utf8").catch(() => null) === "release") process.exit(0);
    await setTimeout(100);
  }
  throw new Error("Timed out waiting to release the outgoing process");
}

if (role !== "verifier") throw new Error(`Unknown fixture role ${role}`);
const [brief, artifact] = await Promise.all([api(`/issues/${taskId}/documents/brief`), api(`/issues/${taskId}/documents/result`)]);
const { first, second } = JSON.parse(brief.body);
const expected = JSON.stringify({ total: first + second });
if (!artifact.latestRevisionId || artifact.body !== expected) throw new Error("The saved artifact failed independent verification");
const revision = await api(`/issues/${taskId}/documents/result/revisions/${artifact.latestRevisionId}`);
if (revision.id !== artifact.latestRevisionId || revision.issueId !== taskId || revision.body !== expected
  || revision.createdByAgentId !== builderId || !revision.createdByRunId) {
  throw new Error("The immutable artifact revision failed independent verification");
}
await api(`/issues/${taskId}`, "PATCH", { status: "done", comment: "The exact saved artifact revision passed verification." });
await writeFile(verificationReceipt, JSON.stringify({ runId, artifactRevisionId: revision.id, artifactAuthorRunId: revision.createdByRunId }), { flag: "wx" });
