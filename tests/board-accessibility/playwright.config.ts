import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const results = resolve(import.meta.dirname, "../../test-results/board-accessibility");
const port = 6193;
const host = "127.0.0.1";
const baseURL = process.env.STORYBOOK_TEST_BASE_URL ?? `http://${host}:${port}`;
const staticDir = process.env.BOARD_A11Y_STORYBOOK_DIR;
const ui = resolve(import.meta.dirname, "../../ui");

export default defineConfig({
  testDir: ".",
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  workers: 1,
  outputDir: resolve(results, "runs"),
  reporter: [["list"], ["html", { open: "never", outputFolder: resolve(results, "report") }]],
  use: {
    browserName: "chromium",
    viewport: { width: 1200, height: 844 },
    reducedMotion: "reduce",
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: process.env.STORYBOOK_TEST_BASE_URL ? undefined : {
    cwd: staticDir ? resolve(staticDir) : ui,
    command: staticDir
      ? `python3 -m http.server ${port} --bind ${host}`
      : `pnpm exec storybook dev -c storybook/.storybook -p ${port} --host ${host} --ci`,
    url: `${baseURL}/index.json`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
