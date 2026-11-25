import { describe, expect, it } from "vitest";
import { computeCaseHandoffRequirementsDigest } from "./case-handoffs.js";

describe("case handoff requirement snapshots", () => {
  it("hashes equivalent snapshots consistently and detects requirement changes", () => {
    const snapshot = { taskTitle: "Work", taskDescription: null, phase: "build", instructions: "Implement it",
      expectedDeliverable: "Patch", prerequisites: ["Read brief"],
      requirementRevision: { id: "contract", revision: 3, canonicalSha256: "a".repeat(64) }, workflowTransition: null, workflowPromptDigest: null };
    expect(computeCaseHandoffRequirementsDigest(snapshot)).toBe(computeCaseHandoffRequirementsDigest({ ...snapshot }));
    expect(computeCaseHandoffRequirementsDigest(snapshot)).not.toBe(computeCaseHandoffRequirementsDigest({ ...snapshot, taskTitle: "Changed" }));
    expect(computeCaseHandoffRequirementsDigest({ ...snapshot, workflowPromptDigest: "b".repeat(64) })).not.toBe(
      computeCaseHandoffRequirementsDigest({ ...snapshot, workflowPromptDigest: "c".repeat(64) }));
  });
});
