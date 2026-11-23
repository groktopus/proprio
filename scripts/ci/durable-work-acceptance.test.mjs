import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDurableWorkGate,
  requiresDurableWorkAcceptance,
} from "./durable-work-acceptance.mjs";

test("routes changes that affect update, restore, or run recovery", () => {
  for (const path of [
    "cli/src/commands/update.ts",
    "cli/src/install-store.ts",
    "packages/db/src/backup-lib.ts",
    "packages/db/src/migrations/9999_fixture.sql",
    "server/src/services/heartbeat/scheduling.ts",
    "server/src/services/runner-goals.ts",
    "packages/proprio-runner/runner/crates/runner-core/src/lib.rs",
    ".github/workflows/linux-source-qualification.yml",
  ]) {
    assert.equal(requiresDurableWorkAcceptance(["doc/GOAL.md", path]), true, path);
  }
});

test("unrelated docs and board changes skip durable-work qualification", () => {
  assert.equal(requiresDurableWorkAcceptance([]), false);
  assert.equal(requiresDurableWorkAcceptance(["doc/GOAL.md", "ui/src/pages/Inbox.tsx"]), false);
});

test("requires a successful acceptance job for applicable changes", () => {
  assert.doesNotThrow(() => assertDurableWorkGate("true", "success"));
  assert.doesNotThrow(() => assertDurableWorkGate("false", "skipped"));
  for (const result of ["", "skipped", "cancelled", "failure"]) {
    assert.throws(() => assertDurableWorkGate("true", result));
  }
  assert.throws(() => assertDurableWorkGate("", "skipped"));
  assert.throws(() => assertDurableWorkGate("false", "failure"));
});
