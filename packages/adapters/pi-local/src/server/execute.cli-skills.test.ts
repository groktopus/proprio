import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_INSTALL_COMMAND } from "../index.js";

const cliPath = process.env.PROPRIO_TEST_PI_CLI;

describe("pinned Pi CLI skill discovery", () => {
  it.skipIf(!cliPath)("loads explicit skills and excludes ambient ones with --no-skills", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-cli-skills-"));
    const agentDir = path.join(root, "agent");
    const workspace = path.join(root, "workspace");
    const selected = path.join(root, "selected");
    async function writeSkill(directory: string, name: string) {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture skill.\n---\nFixture.\n`);
    }
    function cli(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = execFile(cliPath!, args, {
          cwd: workspace,
          env: {
            PATH: process.env.PATH,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            PI_TELEMETRY: "0",
          },
          timeout: 10_000,
        }, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
        child.stdin?.end(input);
      });
    }
    async function skills(flags: string[]) {
      const { stdout } = await cli(
        ["--mode", "rpc", "--no-session", "--no-extensions", "--offline", ...flags],
        '{"id":"skills","type":"get_commands"}\n',
      );
      const response = stdout.trim().split("\n")
        .map((line) => JSON.parse(line))
        .find((message) => message.id === "skills");
      expect(response).toMatchObject({ success: true });
      return response.data.commands
        .filter((command: { source: string }) => command.source === "skill")
        .map((command: { name: string }) => command.name);
    }
    try {
      await fs.mkdir(workspace);
      await writeSkill(path.join(agentDir, "skills", "previous"), "previous");
      await writeSkill(selected, "selected");
      const versionOutput = await cli(["--version"]);
      const version = (versionOutput.stdout || versionOutput.stderr).trim();
      expect(SANDBOX_INSTALL_COMMAND.endsWith(`@${version}`)).toBe(true);
      expect(await skills([])).toContain("skill:previous");
      expect(await skills(["--no-skills", "--skill", selected])).toEqual(["skill:selected"]);
      expect(await skills(["--no-skills"])).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
