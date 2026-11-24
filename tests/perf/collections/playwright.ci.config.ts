import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { resolveProprioInstanceConfigPath } from "../../../packages/shared/src/home-paths";

const port = Number(process.env.PROPRIO_COLLECTION_PERF_PORT ?? 3281);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Set a valid disposable test port");

const home = process.env.PROPRIO_COLLECTION_PERF_CI_HOME;
if (!home) throw new Error("Start this suite with scripts/run-board-performance.sh");

const root = resolve(import.meta.dirname, "../../..");
const baseURL = `http://127.0.0.1:${port}`;
const instanceId = "board-performance";
const lane = process.env.PROPRIO_COLLECTION_PERF_LANE ?? "all";
if (!["all", "work", "timing"].includes(lane)) throw new Error("Set a valid board performance lane");
const results = resolve(root, "test-results/board-performance", lane === "all" ? "" : lane);

export default defineConfig({
  testDir: ".",
  testMatch: ["shell-editor-reads.spec.ts", "shared-project-list.spec.ts", "recent-task-open.spec.ts"],
  workers: 1,
  timeout: lane === "timing" ? 300_000 : 120_000,
  retries: 0,
  use: {
    baseURL,
    extraHTTPHeaders: { Origin: baseURL },
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    cwd: root,
    command: "NODE_ENV=production pnpm --filter @groktopus/ui build --outDir ../server/ui-dist --emptyOutDir && pnpm proprio onboard --yes --run",
    url: `${baseURL}/api/ready`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: "",
      NODE_ENV: "test",
      PORT: String(port),
      PROPRIO_API_URL: baseURL,
      PROPRIO_BIND: "loopback",
      PROPRIO_CONFIG: resolveProprioInstanceConfigPath({ homeDir: home, instanceId }),
      PROPRIO_DISABLE_CWD_ENV_FILE: "true",
      PROPRIO_DEPLOYMENT_EXPOSURE: "private",
      PROPRIO_DEPLOYMENT_MODE: "local_trusted",
      PROPRIO_HOME: home,
      PROPRIO_INSTANCE_ID: instanceId,
      PROPRIO_OPEN_ON_LISTEN: "false",
      PROPRIO_UI_DEV_MIDDLEWARE: "false",
      SERVE_UI: "true",
    },
  },
  outputDir: resolve(results, "playwright"),
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(results, "results.json") }],
  ],
});
