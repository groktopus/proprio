import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readTestServerDatabaseUrl(): Promise<string> {
  const configPath = process.env.PROPRIO_E2E_SERVER_CONFIG;
  if (!configPath) throw new Error("The test server config path is missing");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.database.mode === "postgres") return config.database.connectionString;
  const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
  const port = pid.split("\n")[3];
  if (!/^\d+$/.test(port ?? "")) throw new Error("The embedded test database has no port");
  return `postgres://proprio:proprio@127.0.0.1:${port}/proprio`;
}
