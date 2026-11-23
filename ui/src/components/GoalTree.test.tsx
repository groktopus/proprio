import type { Goal } from "@groktopus/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { GoalTree } from "./GoalTree";

function goal(id: string, parentId: string | null, title: string): Goal {
  return {
    id,
    companyId: "company",
    parentId,
    title,
    level: "team",
    status: "active",
    description: null,
    ownerAgentId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

it("keeps goals in a saved cycle and their descendants visible", () => {
  const output = renderToStaticMarkup(<GoalTree goals={[
    goal("root", null, "Ordinary root"),
    goal("child", "root", "Ordinary child"),
    goal("a", "b", "Cycle member A"),
    goal("b", "a", "Cycle member B"),
    goal("descendant", "a", "Cycle descendant"),
    goal("self", "self", "Self-linked goal"),
  ]} />);

  for (const title of ["Ordinary root", "Ordinary child", "Cycle member A", "Cycle member B", "Cycle descendant", "Self-linked goal"]) {
    expect(output.split(`>${title}<`)).toHaveLength(2);
  }
  expect(output).toContain("Some goals have cyclic parent links");
});
