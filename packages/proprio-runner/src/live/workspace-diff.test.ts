import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captureProprioWorkspace, diffProprioWorkspace } from "./workspace-diff.js";

describe("runner-verified workspace diffs", () => {
  it("captures create, modify, delete, and rename without runner-owned noise", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-workspace-diff-"));
    await mkdir(join(root, ".proprio-runner-prp"));
    await writeFile(join(root, ".proprio-runner-prp", "state.json"), "before");
    await writeFile(join(root, "modify.txt"), "old\n");
    await writeFile(join(root, "delete.txt"), "gone\n");
    await writeFile(join(root, "rename.txt"), "same\n");
    const before = await captureProprioWorkspace(root);

    await writeFile(join(root, ".proprio-runner-prp", "state.json"), "after");
    await writeFile(join(root, "modify.txt"), "new\n");
    await writeFile(join(root, "create.txt"), "created\n");
    await writeFile(join(root, "delete.txt"), "");
    await rename(join(root, "rename.txt"), join(root, "renamed.txt"));
    const after = await captureProprioWorkspace(root);
    const diff = diffProprioWorkspace(before, after, "turn-1:workspace");

    expect(diff?.schema).toBe("proprio.workspace.diff.v1");
    expect(diff?.source).toBe("runner_verified");
    expect(diff?.files.map((file) => [file.path, file.operation])).toEqual([
      ["create.txt", "create"],
      ["delete.txt", "modify"],
      ["modify.txt", "modify"],
      ["renamed.txt", "rename"],
    ]);
    expect(diff?.files.find((file) => file.path === "renamed.txt")?.previousPath).toBe("rename.txt");
    expect(JSON.stringify(diff)).not.toContain(".proprio-runner-prp");
  });

  it("returns no record when the workspace did not change", async () => {
    const root = await mkdtemp(join(tmpdir(), "proprio-workspace-stable-"));
    await writeFile(join(root, "stable.txt"), "same\n");
    const before = await captureProprioWorkspace(root);
    const after = await captureProprioWorkspace(root);
    expect(diffProprioWorkspace(before, after, "turn-1:workspace")).toBeNull();
  });
});
