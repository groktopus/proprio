import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexSkillsInjected, listCodexSkills } from "@groktopus/adapter-codex-local/server";
import { listClaudeSkills } from "@groktopus/adapter-claude-local/server";
import { readProprioRuntimeSkillEntries, resolveLegacyProprioDesiredSkillNames } from "@groktopus/adapter-utils/server-utils";
import { prepareClaudePromptBundle } from "../../../packages/adapters/claude-local/src/server/prompt-cache.js";
import { stageCodexHomeForSync } from "../../../packages/adapters/codex-local/src/server/codex-home.js";

describe("operator-selected feedback skill delivery", () => {
  const cleanup: string[] = [];
  const keys = ["proprio", "complain", "suggestion-box"].map(name => `groktopus/proprio/${name}`);
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(cleanup.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it.each([undefined, []])("keeps feedback opt-in for Codex and Claude with selection %s", async (desiredSkills) => {
    const config = desiredSkills ? { proprioSkillSync: { desiredSkills } } : {};
    for (const [adapterType, list] of [["codex_local", listCodexSkills], ["claude_local", listClaudeSkills]] as const) {
      const snapshot = await list({ agentId: "agent", companyId: "company", adapterType, config });
      expect(snapshot.desiredSkills).toContain(keys[0]);
      for (const feedbackKey of keys.slice(1)) expect(snapshot.desiredSkills).not.toContain(feedbackKey);
    }
  });

  it("mounts the selected skills and shared helper for Codex, Claude and the Codex sandbox home", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-commentary-skills-"));
    cleanup.push(root);
    vi.stubEnv("PROPRIO_HOME", root);
    const entries = await readProprioRuntimeSkillEntries({}, import.meta.dirname, [fileURLToPath(new URL("../../../skills", import.meta.url))]);
    const desiredSkillNames = resolveLegacyProprioDesiredSkillNames({ proprioSkillSync: { desiredSkills: keys.slice(1) } }, entries);
    const selected = entries.filter(e => desiredSkillNames.includes(e.key));
    const codexHome = join(root, "codex");
    await ensureCodexSkillsInjected(async () => {}, { skillsHome: join(codexHome, "skills"), skillsEntries: entries, desiredSkillNames });
    const claude = await prepareClaudePromptBundle({ companyId: "company", skills: selected, instructionsContents: null, onLog: async () => {} });
    const staged = await stageCodexHomeForSync(codexHome, { runId: "commentary-test" });
    cleanup.push(staged);
    for (const skills of [join(codexHome, "skills"), join(claude.addDir, ".claude", "skills"), join(staged, "skills")]) {
      for (const name of ["complain", "suggestion-box"]) {
        expect(await readFile(join(skills, name, "SKILL.md"), "utf8")).toContain("scripts/submit-agent-commentary.mjs");
      }
      expect(await readFile(join(skills, "proprio", "scripts", "submit-agent-commentary.mjs"), "utf8")).toContain("process.stdin");
    }
    // Runtime policy removes entries before explicit selection; never resurrect them.
    const restricted = entries.filter(e => e.key === keys[0]);
    expect(resolveLegacyProprioDesiredSkillNames({}, restricted)).toEqual([keys[0]]);
    expect(await readProprioRuntimeSkillEntries({ proprioRuntimeSkills: [] }, import.meta.dirname)).toEqual([]);
  });
});
