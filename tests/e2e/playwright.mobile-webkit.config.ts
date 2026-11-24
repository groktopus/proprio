import { devices, defineConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

const baseWithoutProjects = { ...baseConfig, projects: undefined };

/**
 * Focused mobile WebKit coverage for the three issue #164 journeys.
 *
 * This uses Playwright's WebKit engine and an iPhone-sized emulated viewport.
 * It does not prove iOS Safari's native keyboard or visual viewport behavior.
 */
export default defineConfig(baseWithoutProjects, {
  testMatch: "mobile-webkit.spec.ts",
  projects: [{
    name: "webkit-mobile",
    use: {
      ...devices["iPhone 13"],
      browserName: "webkit",
    },
  }],
});
