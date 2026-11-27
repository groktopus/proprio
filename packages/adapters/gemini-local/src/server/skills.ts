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
  resolveLegacyProprioDesiredSkillNames,
} from "@groktopus/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveGeminiSkillsHome(
  config: Record<string, unknown>,
  cwd = asString(config.cwd) ?? process.cwd(),
) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  // The adapter env overlays process.env for the child, so mirror that
  // precedence when deciding where Proprio mounts managed skills. An explicit
  // empty value clears an inherited override and falls back to HOME.
  const configuredGeminiHome = typeof env.GEMINI_CLI_HOME === "string"
    ? env.GEMINI_CLI_HOME
    : process.env.GEMINI_CLI_HOME;
  const configuredHome = typeof env.HOME === "string" ? env.HOME : process.env.HOME;
  const geminiHome = configuredGeminiHome || configuredHome || os.homedir();
  return path.join(path.resolve(cwd, geminiHome), ".gemini", "skills");
}

async function buildGeminiSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readProprioRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyProprioDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveGeminiSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "gemini_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: skillsHome,
    missingDetail: "Configured but not currently linked into the Gemini skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Proprio management.",
  });
}

export async function listGeminiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildGeminiSkillSnapshot(ctx.config);
}

export async function syncGeminiSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readProprioRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyProprioDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveGeminiSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensureProprioSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildGeminiSkillSnapshot(ctx.config);
}

export function resolveGeminiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyProprioDesiredSkillNames(config, availableEntries);
}
