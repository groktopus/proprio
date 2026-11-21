import { validEvalLedgerId, type EvalChargeIdentity } from "./cost-ledger.js";

export function braintrustGatewayRequestParent(projectId: string, requestId: string, campaignId: string, identity: EvalChargeIdentity): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
      || ![requestId, campaignId, identity.executionId, identity.attemptId].every(validEvalLedgerId)
      || !["setup", "agent", "judge", "feedback_review", "tool", "infrastructure"].includes(identity.phase)) {
    throw new Error("Invalid eval gateway logging identity");
  }
  return Buffer.concat([Buffer.from([4, 2, 0]), Buffer.from(JSON.stringify({
    object_id: projectId,
    propagated_event: { metadata: {
      proprio_eval_request_id: requestId, proprio_eval_campaign_id: campaignId,
      proprio_eval_execution_id: identity.executionId, proprio_eval_attempt_id: identity.attemptId,
      proprio_eval_phase: identity.phase,
    } },
  }))]).toString("base64");
}
