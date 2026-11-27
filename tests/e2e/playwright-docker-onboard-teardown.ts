import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export default async function teardown() {
  const name = process.env.SMOKE_CONTAINER_NAME;
  if (!name) return;
  const logPath = process.env.SMOKE_LOG_FILE;
  try {
    const logs = execFileSync("docker", ["logs", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (logPath) appendFileSync(logPath, logs);
  } catch {}
  for (const container of [name, `${name}-provider-mock`]) {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }); } catch {}
  }
}
