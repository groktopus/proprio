import type { PluginEvent } from "@groktopus/plugin-sdk";

export interface ActivityPublication {
  companyId: string;
  payload: Record<string, unknown>;
  pluginEvent: PluginEvent | null;
}
