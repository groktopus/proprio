import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@groktopus/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensureProprioSkillSymlink,
  readProprioRuntimeSkillEntries,
  readInstalledSkillTargets,
  removeUnselectedProprioSkillSymlinks,
  resolveLegacyProprioDesiredSkillNames,
} from "@groktopus/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveCursorSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".cursor", "skills");
}

async function buildCursorSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readProprioRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyProprioDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveCursorSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "cursor",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.cursor/skills",
    missingDetail: "Configured but not currently linked into the Cursor skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Proprio management.",
  });
}

export async function listCursorSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildCursorSkillSnapshot(ctx.config);
}

export async function syncCursorSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readProprioRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyProprioDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveCursorSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const selectedEntries = availableEntries.filter((entry) => desiredSet.has(entry.key));

  for (const available of selectedEntries) {
    const target = path.join(skillsHome, available.runtimeName);
    await ensureProprioSkillSymlink(available.source, target);
  }

  await removeUnselectedProprioSkillSymlinks(
    skillsHome,
    availableEntries,
    selectedEntries.map((entry) => entry.runtimeName),
  );

  return buildCursorSkillSnapshot(ctx.config);
}

export function resolveCursorDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyProprioDesiredSkillNames(config, availableEntries);
}
