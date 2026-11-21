import { describe, expect, it } from "vitest";
import {
  listGrokSkills,
  syncGrokSkills,
} from "@groktopus/adapter-grok-local/server";

describe("grok local skill sync", () => {
  const proprioKey = "groktopus/proprio/proprio";

  it("defaults the operational Proprio skill as ephemeral workspace-mounted state", async () => {
    const snapshot = await listGrokSkills({
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "grok_local",
      config: {},
    });

    expect(snapshot.adapterType).toBe("grok_local");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.desiredSkills).toContain(proprioKey);
    expect(snapshot.entries.find((entry) => entry.key === proprioKey)).toMatchObject({
      state: "configured",
      detail: "Will be copied into `.claude/skills` in the execution workspace on the next run.",
    });
  });

  it("tracks unavailable desired Grok skills as missing without persistent install state", async () => {
    const snapshot = await syncGrokSkills({
      agentId: "agent-2",
      companyId: "company-1",
      adapterType: "grok_local",
      config: {
        proprioRuntimeSkills: [],
        proprioSkillSync: {
          desiredSkills: ["unknown-skill"],
        },
      },
    }, ["unknown-skill"]);

    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.warnings).toContain(
      'Desired skill "unknown-skill" is not available from the Proprio skills directory.',
    );
    expect(snapshot.entries).toContainEqual(expect.objectContaining({
      key: "unknown-skill",
      state: "missing",
      origin: "external_unknown",
      targetPath: null,
    }));
  });
});
