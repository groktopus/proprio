import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCloudPostHogConfig } from "../services/cloud-posthog-config.js";
import { resolveBrowserAnalyticsConfig } from "../services/cloud-posthog-browser.js";
import { resolveTelemetryConfig } from "@groktopus/shared/telemetry";
import { announcementFeedService } from "../services/announcement-feed.js";
import { createFeedbackTraceShareClientFromConfig } from "../services/feedback-share-client.js";
import { receiveRetainedProviderPack } from "../services/native-runtime/retained-provider-pack-oci.js";
import {
  proprioCloudConnectorEnrollmentStatus,
  startProprioCloudConnectorEnrollment,
} from "../services/proprio-cloud-connector-enrollment.js";

afterEach(() => vi.unstubAllGlobals());

describe("standalone first-party service guard", () => {
  it("does not activate distribution telemetry even with a legacy enabled setting", () => {
    expect(resolveTelemetryConfig({ enabled: true })).toMatchObject({ enabled: false });
  });

  it("does not activate first-party PostHog analytics or browser replay", () => {
    const env = {
      PROPRIO_POSTHOG_PROJECT_TOKEN: "synthetic",
      PROPRIO_POSTHOG_DIRECT: "1",
      PROPRIO_POSTHOG_BROWSER_ENABLED: "1",
      PROPRIO_POSTHOG_REPLAY_ENABLED: "1",
      PROPRIO_CLOUD_STACK_ID: "synthetic",
    };
    expect(resolveCloudPostHogConfig(env)).toBeNull();
    expect(resolveBrowserAnalyticsConfig(env)).toBeNull();
  });

  it("does not request announcements with no feed configured", async () => {
    const fetch = vi.fn();
    const feed = announcementFeedService({ version: "1.0.0", enabled: true, fetch });
    expect(await feed.current()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not default feedback uploads to a remote host", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(() => createFeedbackTraceShareClientFromConfig({
      feedbackExportBackendUrl: undefined, feedbackExportBackendToken: undefined,
    })).toThrow(/No feedback export service configured/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cannot enroll with a first-party cloud broker", async () => {
    const request = vi.fn();
    expect(proprioCloudConnectorEnrollmentStatus().configured).toBe(false);
    await expect(startProprioCloudConnectorEnrollment({
      origin: "https://local.example.invalid", request,
    })).rejects.toThrow(/not available/);
    expect(request).not.toHaveBeenCalled();
  });

  it("cannot silently use a third-party OCI publisher for retained provider packs", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const input = {} as Parameters<typeof receiveRetainedProviderPack>[0];
    await expect(receiveRetainedProviderPack(input)).rejects.toThrow(/No trusted OCI publisher/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
