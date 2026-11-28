import type {
  CompleteConnectionIntentInput,
  ConnectionIntentInteraction,
  ConnectionIntentSetupOptions,
} from "@groktopus/shared";
import { api } from "./client";

export const connectionIntentsApi = {
  setupOptions: (interactionId: string) =>
    api.get<ConnectionIntentSetupOptions>(
      `/connection-intents/${interactionId}/setup-options`,
    ),
  setPhase: (
    interactionId: string,
    phase: ConnectionIntentInteraction["payload"]["phase"],
    setupAccess?: ConnectionIntentInteraction["payload"]["setupAccess"],
  ) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/phase`,
      { phase, ...(setupAccess ? { setupAccess } : {}) },
    ),
  complete: (interactionId: string, connectionId: CompleteConnectionIntentInput["connectionId"], nativeGitVerifiedAt?: CompleteConnectionIntentInput["nativeGitVerifiedAt"]) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/complete`,
      { connectionId, ...(nativeGitVerifiedAt ? { nativeGitVerifiedAt } : {}) },
    ),
  decline: (interactionId: string, reason?: string) =>
    api.post<ConnectionIntentInteraction>(
      `/connection-intents/${interactionId}/decline`,
      reason ? { reason } : {},
    ),
};
