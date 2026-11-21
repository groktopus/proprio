import { describe, expect, it } from "vitest";
import {
  applyUiBranding,
  getWorktreeUiBranding,
  isWorktreeUiBrandingEnabled,
  renderFaviconLinks,
  renderRuntimeBrandingMeta,
} from "../ui-branding.js";

const TEMPLATE = `<!doctype html>
<head>
    <!-- PROPRIO_RUNTIME_BRANDING_START -->
    <!-- PROPRIO_RUNTIME_BRANDING_END -->
    <!-- PROPRIO_FAVICON_START -->
    <link rel="icon" href="/favicon.ico" sizes="48x48" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
    <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
    <!-- PROPRIO_FAVICON_END -->
</head>`;

describe("ui branding", () => {
  it("detects worktree mode from PROPRIO_IN_WORKTREE", () => {
    expect(isWorktreeUiBrandingEnabled({ PROPRIO_IN_WORKTREE: "true" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PROPRIO_IN_WORKTREE: "1" })).toBe(true);
    expect(isWorktreeUiBrandingEnabled({ PROPRIO_IN_WORKTREE: "false" })).toBe(false);
  });

  it("resolves name, color, and text color for worktree branding", () => {
    const branding = getWorktreeUiBranding({
      PROPRIO_IN_WORKTREE: "true",
      PROPRIO_WORKTREE_NAME: "proprio-pr-432",
      PROPRIO_WORKTREE_COLOR: "#4f86f7",
    });

    expect(branding.enabled).toBe(true);
    expect(branding.name).toBe("proprio-pr-432");
    expect(branding.color).toBe("#4f86f7");
    expect(branding.textColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(branding.faviconHref).toContain("data:image/svg+xml,");
  });

  it("renders a dynamic worktree favicon when enabled", () => {
    const links = renderFaviconLinks(
      getWorktreeUiBranding({
        PROPRIO_IN_WORKTREE: "true",
        PROPRIO_WORKTREE_NAME: "proprio-pr-432",
        PROPRIO_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(links).toContain("data:image/svg+xml,");
    expect(links).toContain('rel="shortcut icon"');
  });

  it("renders runtime branding metadata for the ui", () => {
    const meta = renderRuntimeBrandingMeta(
      getWorktreeUiBranding({
        PROPRIO_IN_WORKTREE: "true",
        PROPRIO_WORKTREE_NAME: "proprio-pr-432",
        PROPRIO_WORKTREE_COLOR: "#4f86f7",
      }),
    );
    expect(meta).toContain('name="proprio-worktree-name"');
    expect(meta).toContain('content="proprio-pr-432"');
    expect(meta).toContain('name="proprio-worktree-color"');
  });

  it("surfaces the runtime instance id so the UI can fail closed on copied rows", () => {
    const branding = getWorktreeUiBranding({
      PROPRIO_IN_WORKTREE: "true",
      PROPRIO_WORKTREE_NAME: "proprio-pr-432",
      PROPRIO_WORKTREE_COLOR: "#4f86f7",
      PROPRIO_INSTANCE_ID: "inst-abc123",
    });
    expect(branding.instanceId).toBe("inst-abc123");

    const meta = renderRuntimeBrandingMeta(branding);
    expect(meta).toContain('name="proprio-instance-id"');
    expect(meta).toContain('content="inst-abc123"');
  });

  it("omits the instance-id meta when the runtime id is unset", () => {
    const branding = getWorktreeUiBranding({
      PROPRIO_IN_WORKTREE: "true",
      PROPRIO_WORKTREE_NAME: "proprio-pr-432",
      PROPRIO_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branding.instanceId).toBeNull();
    expect(renderRuntimeBrandingMeta(branding)).not.toContain('name="proprio-instance-id"');
  });

  it("rewrites the favicon and runtime branding blocks for worktree instances only", () => {
    const branded = applyUiBranding(TEMPLATE, {
      PROPRIO_IN_WORKTREE: "true",
      PROPRIO_WORKTREE_NAME: "proprio-pr-432",
      PROPRIO_WORKTREE_COLOR: "#4f86f7",
    });
    expect(branded).toContain("data:image/svg+xml,");
    expect(branded).toContain('name="proprio-worktree-name"');
    expect(branded).not.toContain('href="/favicon.svg"');

    const defaultHtml = applyUiBranding(TEMPLATE, {});
    expect(defaultHtml).toContain('href="/favicon.svg"');
    expect(defaultHtml).not.toContain('name="proprio-worktree-name"');
  });
});
