export const CASE_HANDOFF_OPEN_TRANSFER_STATES = ["awaiting_release", "pending_dispatch"] as const;
export const CASE_HANDOFF_OPEN_AGENT_STATES = ["offered", ...CASE_HANDOFF_OPEN_TRANSFER_STATES] as const;
export const CASE_HANDOFF_CANCELLABLE_STATES = [...CASE_HANDOFF_OPEN_AGENT_STATES, "awaiting_completion"] as const;
export const CASE_HANDOFF_SOURCE_FENCE_STATES = [...CASE_HANDOFF_OPEN_AGENT_STATES, "delivered"] as const;

export const CASE_HANDOFF_SUPERSEDED_REASON = "case_handoff_superseded";
