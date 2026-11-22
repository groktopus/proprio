import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateAgentsFile, validateRepositoryAgents } from "./check-agents.mjs";

test("accepts contributor guidance with existing relative links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-agents-check-"));
  try {
    writeFileSync(path.join(root, "target.md"), "# Target\n");
    const guide = path.join(root, "AGENTS.md");
    writeFileSync(guide, "# Contributor guidance\nSee [target](target.md).\n");
    assert.deepEqual(validateAgentsFile(guide, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a broken relative link", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-agents-check-"));
  try {
    const guide = path.join(root, "AGENTS.md");
    writeFileSync(guide, "# Contributor guidance\nSee [missing](missing.md).\n");
    assert.deepEqual(validateAgentsFile(guide, root), [
      'AGENTS.md: broken link target "missing.md"',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports malformed escaped relative links", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-agents-check-"));
  try {
    const guide = path.join(root, "AGENTS.md");
    writeFileSync(guide, "# Contributor guidance\nSee [bad](bad%ZZ.md).\n");
    assert.deepEqual(validateAgentsFile(guide, root), [
      'AGENTS.md: invalid encoded link target "bad%ZZ.md"',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds nested contributor guides and validates each one", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-agents-check-"));
  try {
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(root, "AGENTS.md"), "# Root guidance\n");
    writeFileSync(path.join(nested, "AGENTS.md"), "# Nested guidance\n[broken](nope.md)\n");
    assert.deepEqual(validateRepositoryAgents(root), [
      'nested/AGENTS.md: broken link target "nope.md"',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts Markdown link titles, angle destinations, and nested parentheses", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-agents-markdown-"));
  try {
    for (const name of ["target.md", "target with spaces.md", "target(part).md"]) writeFileSync(path.join(root, name), "# Target\n");
    const guide = path.join(root, "AGENTS.md");
    writeFileSync(guide, `# Guidance
[double](target.md "Title")
[single](target.md 'Title')
[parenthesized](target.md (Title))
[spaces](<target with spaces.md>)
[nested](target(part).md)
[encoded](target%20with%20spaces.md#section)
[reference][target]

[target]: target.md "Reference title"
`);
    assert.deepEqual(validateAgentsFile(guide, root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("ignores code examples and external links but validates references and images", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "proprio-agents-markdown-"));
  try {
    const guide = path.join(root, "AGENTS.md");
    writeFileSync(guide, '# Guidance\n`[example](absent.md)`\n\n```md\n[example](absent.md)\n```\n[web](https://example.test/missing)\n[anchor](#section)\n[reference][missing]\n\n[missing]: absent.md "Title"\n![image](absent.png)\n');
    assert.deepEqual(validateAgentsFile(guide, root), [
      'AGENTS.md: broken link target "absent.md"',
      'AGENTS.md: broken link target "absent.png"',
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
