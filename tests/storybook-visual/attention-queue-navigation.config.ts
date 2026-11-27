import { defineConfig } from "@playwright/test";

const port = Number(process.env.ATTENTION_QUEUE_STORYBOOK_PORT ?? 6157);

export default defineConfig({
  testDir: ".",
  testMatch: "attention-queue-navigation.spec.ts",
  timeout: 60_000,
  retries: 1,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "attention-queue-playwright-report" }]],
  use: {
    browserName: "chromium",
    baseURL: process.env.STORYBOOK_TEST_BASE_URL ?? `http://127.0.0.1:${port}`,
    contextOptions: { reducedMotion: "reduce" },
  },
  webServer: process.env.STORYBOOK_TEST_BASE_URL ? undefined : {
    command: `node ../../scripts/serve-storybook-static.mjs --port ${port}`,
    url: `http://127.0.0.1:${port}/index.json`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
