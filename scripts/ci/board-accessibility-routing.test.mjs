import { strict as assert } from "node:assert";
import { test } from "node:test";
import { requiresBoardAccessibility } from "./board-accessibility-routing.mjs";

test("routes board source, shared inputs, fixtures and browser configuration", () => {
  for (const path of [
    "ui/src/index.css",
    "ui/src/components/MobileBottomNav.tsx",
    "ui/storybook/.storybook/preview.ts",
    "packages/shared/src/index.ts",
    "packages/plugins/sdk/package.json",
    "packages/adapters/codex-local/package.json",
    "packages/adapter-utils/src/index.ts",
    "maps/feature-map/README.md",
    "scripts/check-maps.mjs",
    "scripts/feature-map.mjs",
    "scripts/ensure-plugin-build-deps.mjs",
    "tests/board-accessibility/playwright.config.ts",
    "tests/storybook-visual/playwright.config.ts",
    "scripts/storybook-catalog.mjs",
    ".github/workflows/stability-smoke.yml",
    "pnpm-lock.yaml",
  ]) {
    assert.equal(requiresBoardAccessibility([path]), true, path);
  }
});

test("skips unrelated source and documentation changes", () => {
  assert.equal(requiresBoardAccessibility([]), false);
  assert.equal(requiresBoardAccessibility(["doc/DATABASE.md", "server/src/services/budgets.ts"]), false);
});
