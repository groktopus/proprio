import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Db } from "@groktopus/db";
import { companySkillService } from "../services/company-skills.js";

// Nonempty selection now first acquires a dedicated connection. Route that
// connection to the same fail-on-access fixture; empty selection must skip it.
vi.mock("@groktopus/db", async importOriginal => ({
  ...await importOriginal<typeof import("@groktopus/db")>(),
  withDedicatedDbConnection: <T>(database: Db, action: (connection: Db) => Promise<T>) => action(database),
}));

const databaseAccess = new Error("Runtime selection touched the inventory database");
const db = new Proxy({} as Db, { get() { throw databaseAccess; } });

it.each([
  { onlyKeys: new Set<string>() },
  { onlyKeys: new Set<string>(), includeLegacy: true, selectionConfig: { proprioSkillSync: { desiredSkills: ["selected"] } } },
  { selectionConfig: {} },
  { selectionConfig: { proprioSkillSync: { desiredSkills: [] } } },
  { selectionConfig: { proprioSkillSync: { desiredSkills: [" ", null, {}] } } },
])("does no inventory work for an empty runtime selection: %o", async options => {
  await expect(companySkillService(db).listRuntimeSkillEntries(randomUUID(), options)).resolves.toEqual([]);
});

it.each([
  {},
  { includeLegacy: true, selectionConfig: {} },
  { includeLegacy: true, selectionConfig: { proprioSkillSync: { desiredSkills: [] } } },
  { selectionConfig: { proprioSkillSync: { desiredSkills: ["selected"] } } },
  { onlyKeys: new Set(["selected"]), selectionConfig: {} },
])("retains inventory resolution for a requested or legacy skill set: %o", async options => {
  await expect(companySkillService(db).listRuntimeSkillEntries(randomUUID(), options)).rejects.toBe(databaseAccess);
});
