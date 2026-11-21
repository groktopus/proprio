export type CloudPostHogConfig = {
  token: string; // PROPRIO_POSTHOG_PROJECT_TOKEN
  host: string;
  environment: string | null; // PROPRIO_POSTHOG_ENVIRONMENT
  stackId: string; // PROPRIO_CLOUD_STACK_ID
  directEnabled: boolean; // PROPRIO_POSTHOG_DIRECT !== "0"
  browserEnabled: boolean; // PROPRIO_POSTHOG_BROWSER_ENABLED === "1"
  replayEnabled: boolean; // browserEnabled && PROPRIO_POSTHOG_REPLAY_ENABLED !== "0"
};

export const DEFAULT_CLOUD_POSTHOG_HOST = "";

export function resolveCloudPostHogConfig(
  _env: Record<string, string | undefined> = process.env,
): CloudPostHogConfig | null { return null; }

export function isPostHogDirectDeliveryEnabled(
  config: CloudPostHogConfig | null,
): config is CloudPostHogConfig & { environment: string } {
  return Boolean(config?.directEnabled && config.environment);
}
