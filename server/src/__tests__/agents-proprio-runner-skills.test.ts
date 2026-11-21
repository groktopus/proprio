import { describe, expect, it } from "vitest";
import { PROPRIO_RUNNER_DEFAULT_MODELS } from "@groktopus/adapter-utils/proprio-runner-permissions";
import {
  normalizeProprioOperationalSkillPreference,
  normalizeProprioRunnerAdapterConfig,
  PROPRIO_OPERATIONAL_SKILL_KEY,
  resolveLegacyProprioDesiredSkillNames,
} from "@groktopus/adapter-utils/server-utils";

const legacyConfig = {
  proprioSkillSync: {
    desiredSkills: [PROPRIO_OPERATIONAL_SKILL_KEY],
  },
};

describe("proprio_runner operational skill normalization", () => {
  it("applies full-auto native runner defaults at persistence boundaries", () => {
    expect(normalizeProprioRunnerAdapterConfig("proprio_runner", {})).toEqual({
      provider: "codex",
      model: PROPRIO_RUNNER_DEFAULT_MODELS.codex,
      codexPermissionMode: "never",
    });
  });

  it("repairs an existing blank model without replacing an explicit model", () => {
    expect(normalizeProprioRunnerAdapterConfig("proprio_runner", { model: "" }))
      .toMatchObject({ model: PROPRIO_RUNNER_DEFAULT_MODELS.codex });
    expect(normalizeProprioRunnerAdapterConfig("proprio_runner", { model: "gpt-5.5" }))
      .toMatchObject({ model: "gpt-5.5" });
  });

  it("does not replace a non-Codex provider model with the Codex default", () => {
    expect(normalizeProprioRunnerAdapterConfig("proprio_runner", {
      provider: "claude_managed",
      model: "claude-sonnet-5",
    })).toMatchObject({
      provider: "claude_managed",
      model: "claude-sonnet-5",
    });
  });

  it("removes the legacy operational skill while preserving optional skills", () => {
    const normalized = normalizeProprioOperationalSkillPreference("proprio_runner", {
      proprioSkillSync: {
        desiredSkills: [PROPRIO_OPERATIONAL_SKILL_KEY, "company-1/reviewer"],
      },
    });

    expect(normalized).toEqual({
      proprioSkillSync: { desiredSkills: ["company-1/reviewer"] },
    });
  });

  it("restores the required operational skill through the legacy resolver after switching back", () => {
    const normalized = normalizeProprioOperationalSkillPreference("proprio_runner", legacyConfig);
    expect(resolveLegacyProprioDesiredSkillNames(normalized, [{
      key: PROPRIO_OPERATIONAL_SKILL_KEY,
      runtimeName: "proprio",
    }])).toEqual([PROPRIO_OPERATIONAL_SKILL_KEY]);
  });

  it("does not change direct adapter preferences", () => {
    expect(normalizeProprioOperationalSkillPreference("codex_local", legacyConfig)).toBe(legacyConfig);
  });
});
