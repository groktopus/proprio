import { afterEach, describe, expect, it, vi } from "vitest";

const publishLiveEvent = vi.hoisted(() => vi.fn());
vi.mock("../services/live-events.js", () => ({ publishLiveEvent }));

import { publishActivity, setPluginEventBus } from "../services/activity-log.js";

describe("task-tree budget activity privacy", () => {
  afterEach(() => publishLiveEvent.mockClear());

  it("broadcasts only a generic invalidation and suppresses unfiltered plugin events", async () => {
    const emit = vi.fn().mockResolvedValue({ errors: [] });
    setPluginEventBus({ emit } as never);
    publishActivity({
      companyId: "company-id",
      payload: {
        issueId: "private-root-id", actorType: "user", actorId: "operator-id", action: "budget.hard_threshold_crossed",
        entityType: "budget_incident", entityId: "private-incident-id", agentId: null, runId: null,
        responsibleUserId: null, details: { scopeType: "task_tree", scopeId: "private-root-id", amountObserved: 175 },
      },
      pluginEvent: { companyId: "company-id", eventId: "event-id", eventType: "budget.incident.opened",
        occurredAt: new Date().toISOString(), actorId: "operator-id", actorType: "user", entityId: "private-root-id",
        entityType: "budget_incident", payload: { scopeType: "task_tree", scopeId: "private-root-id" } } as never,
    });

    expect(publishLiveEvent).toHaveBeenCalledExactlyOnceWith({
      companyId: "company-id", type: "activity.logged", payload: {
        action: "budgets.changed", entityType: "budget", entityId: "budget", issueId: null,
        actorType: "user", actorId: "operator-id",
      },
    });
    expect(emit).not.toHaveBeenCalled();
  });
});
