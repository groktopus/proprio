import { resolveProprioRunnerPiThinkingLevel } from "./proprio-runner-permissions.js";
import { describe, expect, it } from "vitest";

import {
  PROPRIO_RUNNER_DEFAULT_MODELS,
  PROPRIO_RUNNER_ACPX_PROFILES,
  proprioRunnerTransitionConfig,
  isProprioRunnerProvider,
  resolveProprioRunnerModel,
  resolveProprioRunnerPermissionMode,
  resolveProprioRunnerCursorMode,
} from "./proprio-runner-permissions.js";

describe("Proprio Runner permission defaults", () => {
  it("exposes qualified Kimi Code with an explicit runtime credential", () => {
    expect(PROPRIO_RUNNER_ACPX_PROFILES.find(profile => profile.value === "kimi"))
      .toMatchObject({ qualified: true, credentialEnvironment: ["KIMI_API_KEY"] });
  });
  it("marks Pi and Copilot qualified with their provider credential bindings", () => {
    expect(PROPRIO_RUNNER_ACPX_PROFILES.find(profile => profile.value === "pi"))
      .toMatchObject({ qualified: true, credentialEnvironment: expect.arrayContaining(["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) });
    expect(PROPRIO_RUNNER_ACPX_PROFILES.find(profile => profile.value === "copilot"))
      .toMatchObject({ qualified: true, credentialEnvironment: ["COPILOT_GITHUB_TOKEN"] });
  });
  it("defaults Codex to the only qualified non-interactive mode", () => {
    expect(resolveProprioRunnerPermissionMode("codex", undefined)).toBe(
      "never",
    );
    expect(resolveProprioRunnerPermissionMode("codex", "on-request")).toBe("never");
    expect(resolveProprioRunnerPermissionMode("codex", "untrusted")).toBe("never");
  });

  it("defaults Claude and OpenCode to full auto", () => {
    expect(resolveProprioRunnerPermissionMode("opencode", undefined)).toBe(
      "allow",
    );
    expect(resolveProprioRunnerPermissionMode("acpx", undefined)).toBe(
      "approve-all",
    );
  });

  it.each(["approve-proprio", "approve-reads", "deny-all", "approve-all"])("preserves explicit Claude %s settings", (mode) => {
    expect(resolveProprioRunnerPermissionMode("acpx", mode)).toBe(mode);
  });

  it.each([
    ["claude_local", "acpxPermissionMode", "approve-all"],
    ["codex_local", "codexPermissionMode", "never"],
    ["opencode_local", "opencodePermissionMode", "allow"],
    ["pi_local", "acpxPermissionMode", "approve-all"],
    ["grok_local", "acpxPermissionMode", "approve-all"],
  ])("uses full auto when converting %s to the new runner", (adapter, key, value) => {
    expect(proprioRunnerTransitionConfig(adapter, undefined)).toMatchObject({ [key]: value });
  });

  it("keeps Pi models explicit during conversion", () => {
    expect(proprioRunnerTransitionConfig("pi_local", undefined)).toMatchObject({ provider: "acpx", acpxAgent: "pi", model: "" });
    expect(proprioRunnerTransitionConfig("pi_local", "openrouter/provider/model")).toMatchObject({ provider: "acpx", acpxAgent: "pi", model: "openrouter/provider/model" });
  });

  it("keeps Grok's harness and model when converting its adapter", () => {
    expect(proprioRunnerTransitionConfig("grok_local", "grok-4.7"))
      .toMatchObject({ provider: "acpx", acpxAgent: "grok", model: "grok-4.7" });
  });

  it.each([undefined, "", "grok-build"])("resolves Grok's legacy default %s to the native model", model => {
    expect(proprioRunnerTransitionConfig("grok_local", model)).toMatchObject({ model: "grok-4.7" });
  });

  it("recognizes only exact provider identifiers", () => {
    expect(isProprioRunnerProvider("cursor_cloud")).toBe(true);
    expect(isProprioRunnerProvider("codex")).toBe(true);
    expect(isProprioRunnerProvider("opencode")).toBe(true);
    expect(isProprioRunnerProvider("claude_managed")).toBe(true);
    expect(isProprioRunnerProvider("aws_agentcore")).toBe(true);
    expect(isProprioRunnerProvider("acpx")).toBe(true);
    expect(isProprioRunnerProvider("toString")).toBe(false);
    expect(isProprioRunnerProvider("__proto__")).toBe(false);
  });

  it("keeps managed provider permissions under the qualified profile", () => {
    expect(resolveProprioRunnerPermissionMode("cursor_cloud", "never")).toBe("provider-managed");
    expect(resolveProprioRunnerPermissionMode("claude_managed", "never"))
      .toBe("provider-managed");
    expect(resolveProprioRunnerPermissionMode("aws_agentcore", "approve-all"))
      .toBe("provider-managed");
  });

  it("converts Cursor Cloud without substituting an implicit model or adding command permission controls", () => {
    expect(proprioRunnerTransitionConfig("cursor_cloud", "custom-model")).toEqual({ provider: "cursor_cloud", model: "custom-model", lifecycleMode: "per_turn" });
    expect(proprioRunnerTransitionConfig("cursor_cloud", undefined)).toEqual({ provider: "cursor_cloud", model: "", lifecycleMode: "per_turn" });
  });

  it("uses the Codex default for missing or blank models", () => {
    expect(resolveProprioRunnerModel("codex", undefined)).toBe(
      PROPRIO_RUNNER_DEFAULT_MODELS.codex,
    );
    expect(resolveProprioRunnerModel("codex", "   ")).toBe(
      PROPRIO_RUNNER_DEFAULT_MODELS.codex,
    );
  });

  it("preserves an explicit Codex model", () => {
    expect(resolveProprioRunnerModel("codex", "gpt-5.5")).toBe("gpt-5.5");
    expect(resolveProprioRunnerModel("codex", "  gpt-5.5  ")).toBe("gpt-5.5");
  });
});


describe("Cursor session mode admission", () => {
  it.each([undefined, "agent", "plan", "ask"])("retains mode %s with an explicit Cursor default", mode => {
    expect(resolveProprioRunnerCursorMode("acpx", "cursor", mode)).toBe(mode ?? "agent");
  });
  it.each([null, "", "auto", "PLAN", true, {}, ["plan"]])("rejects invalid mode %j", mode => {
    expect(() => resolveProprioRunnerCursorMode("acpx", "cursor", mode)).toThrow("Cursor session mode");
  });
  it.each([["codex", "cursor"], ["acpx", "copilot"], ["acpx", "pi"], ["acpx", "claude"]])("rejects mode on %s/%s", (provider, agent) => {
    expect(resolveProprioRunnerCursorMode(provider, agent, undefined)).toBeUndefined();
    expect(() => resolveProprioRunnerCursorMode(provider, agent, "plan")).toThrow("only for Cursor");
  });
});

describe("Pi thinking configuration", () => {
  it.each([undefined, "off", "low", "high", "max"] as const)("persists exact level %s with low as the fresh-config default", value => {
    expect(resolveProprioRunnerPiThinkingLevel("acpx", "pi", value)).toBe(value ?? "low");
  });
  it.each(["medium", "minimal", "xhigh", "", null, 1])("rejects unsupported alias %s", value => {
    expect(() => resolveProprioRunnerPiThinkingLevel("acpx", "pi", value)).toThrow();
  });
  it("rejects foreign provider settings", () => {
    expect(() => resolveProprioRunnerPiThinkingLevel("codex", "pi", "low")).toThrow(/only/);
    expect(() => resolveProprioRunnerPiThinkingLevel("acpx", "cursor", "low")).toThrow(/only/);
    expect(resolveProprioRunnerPiThinkingLevel("codex", undefined, undefined)).toBeUndefined();
  });
});
