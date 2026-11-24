import { devices, defineConfig } from "@playwright/test";
import process from "node:process";
import baseConfig from "./playwright.config";

const baseWithoutProjects = { ...baseConfig, projects: undefined, webServer: undefined };
const webServerEnv = { ...process.env };
delete webServerEnv.DATABASE_URL;
delete webServerEnv.DATABASE_MIGRATION_URL;

/**
 * Focused mobile WebKit coverage for the three issue #164 journeys.
 *
 * This uses Playwright's WebKit engine and an iPhone-sized emulated viewport.
 * It does not prove iOS Safari's native keyboard or visual viewport behavior.
 */
export default defineConfig(baseWithoutProjects, {
  testMatch: "mobile-webkit.journey.ts",
  projects: [{
    name: "webkit-mobile",
    use: {
      ...devices["iPhone 13"],
      browserName: "webkit",
    },
  }],
  webServer: baseConfig.webServer ? {
    ...baseConfig.webServer,
    env: {
      ...webServerEnv,
      ...baseConfig.webServer.env,
      DATABASE_URL: "",
      DATABASE_MIGRATION_URL: "",
      PROPRIO_DISABLE_CWD_ENV_FILE: "true",
    },
  } : undefined,
});
