interface SessionRun {
  id: string;
  taskId: string;
  sessionDigest: string;
  runnerDigest: string;
  runnerGenerations: number[];
  compactionRequestId: string | null;
  startedAt: number;
  finishedAt: number;
  status: string;
}

interface CompactionEvent {
  runId: string;
  reason: string;
  sameSession: boolean;
  sequence: number;
}

export interface CompactionObservation {
  sourceRevision: string;
  profileId: string;
  model: string;
  provider: string;
  fixtureDigest: string;
  taskId: string;
  initial: SessionRun;
  waiting: SessionRun;
  final: SessionRun;
  compactRequest: { requestId: string; run: SessionRun } | null;
  compactionEvents: CompactionEvent[];
  prerequisite: { receiptId: string; publishedAt: number } | null;
  actions: Array<{ runId: string; kind: "request_prerequisite" | "write_artifact"; at: number }>;
  artifact: { taskId: string; revisionId: string; writtenByRunId: string; body: string } | null;
}

export interface CompactionFixtureRequirements {
  retainedMarker: string;
  supersededFormat: string;
  activeFormat: string;
  releaseCode: string;
}

function outputFields(body: string) {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // A result that cannot be parsed fails the format and revision checks.
  }
  return {};
}

function gradeLane(lane: CompactionObservation, mode: "control" | "treatment", fixture: CompactionFixtureRequirements, requirementRevisionId: string) {
  const { initial, waiting, final, compactRequest, prerequisite, actions, artifact } = lane;
  const runs = [initial, ...(compactRequest ? [compactRequest.run] : []), waiting, final];
  const continuingSession = Boolean(initial.sessionDigest && initial.runnerDigest)
    && new Set(runs.map(run => run.id)).size === runs.length
    && runs.every((run, index) => Boolean(run.id) && run.taskId === lane.taskId && run.status === "succeeded"
      && run.sessionDigest === initial.sessionDigest && run.runnerDigest === initial.runnerDigest
      && Number.isFinite(run.startedAt) && run.finishedAt >= run.startedAt
      && (index === 0 || run.startedAt >= runs[index - 1]!.finishedAt));
  const compaction = mode === "control"
    ? compactRequest === null && runs.every(run => run.compactionRequestId === null) && lane.compactionEvents.length === 0
    : Boolean(compactRequest?.requestId) && lane.compactionEvents.length === 1
      && compactRequest?.run.compactionRequestId === compactRequest?.requestId
      && [initial, waiting, final].every(run => run.compactionRequestId === null)
      && lane.compactionEvents[0]?.runId === compactRequest?.run.id
      // Codex emits its provider notification in response to the admitted manual request.
      && lane.compactionEvents[0]?.reason === "provider" && lane.compactionEvents[0]?.sameSession === true
      && Number.isSafeInteger(lane.compactionEvents[0]?.sequence) && lane.compactionEvents[0]!.sequence > 0;
  const fields = outputFields(artifact?.body ?? "");
  const requests = actions.filter(action => action.kind === "request_prerequisite");
  const writes = actions.filter(action => action.kind === "write_artifact");
  return {
    continuingSession,
    compaction,
    retainedRequirement: Boolean(fixture.retainedMarker) && fields.marker === fixture.retainedMarker,
    currentRequirementsApplied: Boolean(requirementRevisionId) && fields.format === fixture.activeFormat
      && fields.requirementRevisionId === requirementRevisionId,
    supersededInstructionOmitted: Boolean(fixture.supersededFormat) && Boolean(artifact?.body)
      && !artifact!.body.includes(fixture.supersededFormat),
    prerequisiteRespected: Boolean(prerequisite?.receiptId) && fields.releaseCode === fixture.releaseCode && Boolean(prerequisite &&
      prerequisite.publishedAt >= waiting.finishedAt && prerequisite.publishedAt <= final.startedAt)
      && requests.length === 1 && requests[0]!.runId === waiting.id && requests[0]!.at >= waiting.startedAt
      && requests[0]!.at <= waiting.finishedAt
      && writes.length === 1 && writes[0]!.runId === final.id && writes[0]!.at >= final.startedAt
      && writes[0]!.at <= final.finishedAt,
    persistedArtifact: Boolean(artifact?.revisionId) && artifact?.taskId === lane.taskId && artifact?.writtenByRunId === final.id,
  };
}

/** Grade persisted product observations from an equivalent Codex pair. */
export function gradeContextCompactionPair(input: {
  control: CompactionObservation;
  treatment: CompactionObservation;
  fixture: CompactionFixtureRequirements;
  requirementRevisionIds: { control: string; treatment: string };
}) {
  const { control, treatment, fixture, requirementRevisionIds } = input;
  const matchingInputs = (["sourceRevision", "profileId", "model", "fixtureDigest"] as const)
    .every(key => Boolean(control[key]) && control[key] === treatment[key]);
  return {
    matchedPair: Boolean(control.taskId && treatment.taskId && control.taskId !== treatment.taskId)
      && Boolean(control.initial.sessionDigest && treatment.initial.sessionDigest && control.initial.sessionDigest !== treatment.initial.sessionDigest)
      && matchingInputs && control.provider === "codex" && treatment.provider === "codex",
    control: gradeLane(control, "control", fixture, requirementRevisionIds.control),
    treatment: gradeLane(treatment, "treatment", fixture, requirementRevisionIds.treatment),
  };
}
