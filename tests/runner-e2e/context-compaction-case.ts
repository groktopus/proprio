import { createHash } from "node:crypto";
import type { RunnerTaskFixture } from "./types.js";

export const COMPACTION_BUDGET_CENTS = 1_000;
export const COMPACTION_FIXTURE = {
  retainedMarker: "keep-amber",
  supersededFormat: "obsolete-v1",
  activeFormat: "current-v2",
  releaseCode: "EMBER-72",
} as const;

export const COMPACTION_PROMPT = [
  "Prepare a synthetic release receipt. Use the saved requirements document on this task as the source of truth.",
  "Read the initial requirements and ask exactly one free-text question for permission to start the prerequisite check. Wait for the answer.",
  "After permission, ask exactly one free-text question for the release code. Wait for the answer. Do not create or try to write the result yet.",
  "Once you have the release code, save the result as a Proprio task document with key result. Follow the current requirements and finish this task.",
].join("\n");

export function compactionRequirements(format: string) {
  return `The result body must be a JSON object with marker ${JSON.stringify(COMPACTION_FIXTURE.retainedMarker)}, format ${JSON.stringify(format)}, requirementRevisionId set to this document's current saved revision ID, and releaseCode set to the answer supplied by the operator. The result must not be written before that answer.`;
}

export const COMPACTION_FIXTURE_DIGEST = createHash("sha256").update(JSON.stringify({ prompt: COMPACTION_PROMPT,
  fixture: COMPACTION_FIXTURE, original: compactionRequirements(COMPACTION_FIXTURE.supersededFormat),
  revision: compactionRequirements(COMPACTION_FIXTURE.activeFormat) })).digest("hex");

export const contextCompactionTask: RunnerTaskFixture = {
  id: "matched-continuations",
  label: "Matched task continuations with and without compaction",
  groups: ["native", "context-integrity"],
  workMode: "standard",
  flow: "context_compaction",
  expectedRunCount: 7,
  attemptTimeoutMs: { local: 12 * 60_000, daytona: 12 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: (nonce) => `Synthetic release receipt ${nonce}`,
  buildPrompt: () => COMPACTION_PROMPT,
  buildVisibleMarker: () => COMPACTION_FIXTURE.retainedMarker,
  buildMatchers: () => [],
};
