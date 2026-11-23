import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@groktopus/adapter-utils";
import {
  parseObject,
  resolveProprioInstanceRootForAdapter,
  type ProprioSkillEntry,
  isProprioSkillSourceMissing,
  readInstalledSkillTargets,
  readProprioRuntimeSkillEntries,
  resolveLegacyProprioDesiredSkillNames,
} from "@groktopus/adapter-utils/server-utils";
import { fileURLToPath } from "node:url";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveHermesHome(config: Record<string, unknown>): string {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const hermesHome = asString(env.HERMES_HOME);
  return hermesHome ? path.resolve(hermesHome) : path.join(configuredHome ? path.resolve(configuredHome) : os.homedir(), ".hermes");
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val: unknown = line.slice(idx + 1).trim();
    // Strip quotes
    if (typeof val === "string" && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    frontmatter[key] = val;
  }
  return frontmatter as SkillFrontmatter;
}

async function scanHermesSkills(
  skillsHome: string,
): Promise<AdapterSkillEntry[]> {
  const entries: AdapterSkillEntry[] = [];

  try {
    const categories = await fs.readdir(skillsHome, { withFileTypes: true });
    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = path.join(skillsHome, cat.name);

      // Check if the category directory itself has a SKILL.md (top-level skill)
      const topLevelSkillMd = path.join(catPath, "SKILL.md");
      if (await fs.stat(topLevelSkillMd).catch(() => null)) {
        entries.push(await buildSkillEntry(cat.name, topLevelSkillMd, cat.name));
      }

      // Scan for sub-skills
      const items = await fs.readdir(catPath, { withFileTypes: true }).catch(() => []);
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const skillMd = path.join(catPath, item.name, "SKILL.md");
        if (await fs.stat(skillMd).catch(() => null)) {
          const key = item.name;
          entries.push(await buildSkillEntry(key, skillMd, `${cat.name}/${item.name}`));
        }
      }
    }
  } catch {
    // ~/.hermes/skills/ doesn't exist — no skills available
  }

  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

async function buildSkillEntry(
  key: string,
  skillMdPath: string,
  categoryPath: string,
): Promise<AdapterSkillEntry> {
  let description: string | null = null;
  try {
    const content = await fs.readFile(skillMdPath, "utf8");
    const fm = parseSkillFrontmatter(content);
    description = fm.description ?? null;
  } catch {
    // ignore
  }

  return {
    key,
    runtimeName: key,
    desired: true, // Hermes loads all available skills
    managed: false,
    state: "installed",
    origin: "user_installed",
    originLabel: "Hermes skill",
    locationLabel: `~/.hermes/skills/${categoryPath}`,
    readOnly: true, // Hermes manages its own skills — Proprio can't toggle them
    sourcePath: skillMdPath,
    targetPath: null,
    detail: description,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function buildHermesSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const home = resolveHermesHome(config);
  const hermesSkillsHome = path.join(home, "skills");

  // 1. Scan Proprio-managed skills (bundled with the adapter)
  const proprioEntries = await readProprioRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyProprioDesiredSkillNames(config, proprioEntries);
  const desiredSet = new Set(desiredSkills);
  const availableByKey = new Map(proprioEntries.map((e) => [e.key, e]));

  // 2. Scan Hermes's own skills from ~/.hermes/skills/
  const hermesSkillEntries = await scanHermesSkills(hermesSkillsHome);
  const hermesKeys = new Set(hermesSkillEntries.map((e) => e.key));

  // 3. Merge: Proprio skills first (ephemeral), then Hermes skills
  const entries: AdapterSkillEntry[] = [];
  const warnings: string[] = [];

  // Proprio-managed skills
  for (const entry of proprioEntries) {
    const desired = desiredSet.has(entry.key);
    entries.push({
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: "company_managed",
      originLabel: "Managed by Proprio",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired
        ? "Will be available on the next run via Hermes skill loading."
        : null,
    });
  }

  // Hermes-installed skills (read-only, always loaded)
  for (const entry of hermesSkillEntries) {
    // Skip if Proprio already manages a skill with the same key
    if (availableByKey.has(entry.key)) continue;
    entries.push(entry);
  }

  // Check for desired skills that don't exist
  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill) || hermesKeys.has(desiredSkill)) continue;
    warnings.push(
      `Desired skill "${desiredSkill}" is not available in Proprio or Hermes skills.`,
    );
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail:
        "Cannot find this skill in Proprio or ~/.hermes/skills/.",
    });
  }

  return {
    adapterType: "hermes_local",
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listHermesSkills(
  ctx: AdapterSkillContext,
): Promise<AdapterSkillSnapshot> {
  return buildHermesSkillSnapshot(ctx.config);
}

async function readBundledSkillPackage(source: string, name: string) {
  const root = path.resolve(source, "../..");
  if (path.resolve(source) !== path.join(root, "skills", name)) return null;

  try {
    const manifest = parseObject(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")));
    const repository = parseObject(manifest.repository);
    if (
      (manifest.name !== "@groktopus/server" && manifest.name !== "@groktopus/hermes-proprio-adapter") ||
      repository.url !== "https://github.com/groktopus/proprio" ||
      typeof manifest.version !== "string" || !manifest.version
    ) return null;

    // A package may itself be reached through a symlink. Its bundled skill
    // directory and manifest must still reside inside that exact package.
    const packageRoot = await fs.realpath(root);
    if (await fs.realpath(source) !== path.join(packageRoot, "skills", name)) return null;
    if (await fs.realpath(path.join(root, "package.json")) !== path.join(packageRoot, "package.json")) return null;
    if (!(await fs.lstat(path.join(source, "SKILL.md"))).isFile()) return null;
    return { name: manifest.name, version: manifest.version };
  } catch {
    return null;
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function isSameCachedSkill(
  source: string,
  previous: string,
  companyId: string,
  versionId: string,
): Promise<boolean> {
  const skillRoot = path.dirname(source);
  const skillId = path.basename(skillRoot);
  const priorVersionId = path.basename(previous);
  if (![companyId, skillId, versionId, priorVersionId].every(value => uuid.test(value))) return false;
  if (path.basename(source) !== versionId || path.dirname(previous) !== skillRoot) return false;

  const instanceRoot = resolveProprioInstanceRootForAdapter();
  const relativeRoot = path.join("skills", companyId, "__versions__", skillId);
  if (skillRoot !== path.join(instanceRoot, relativeRoot)) return false;
  try {
    const canonicalRoot = path.join(await fs.realpath(instanceRoot), relativeRoot);
    if (await fs.realpath(skillRoot) !== canonicalRoot) return false;
    if (await fs.realpath(source) !== path.join(canonicalRoot, versionId)) return false;
    const oldVersion = await fs.lstat(previous).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; // The version cache can evict old bytes.
      throw error;
    });
    return oldVersion === null || oldVersion.isDirectory();
  } catch {
    return false;
  }
}

async function ownsPreviousSkillLink(
  entry: ProprioSkillEntry,
  companyId: string,
  source: string,
  previous: string,
): Promise<boolean> {
  if (entry.versionId) return isSameCachedSkill(source, previous, companyId, entry.versionId);
  if (entry.key !== `groktopus/proprio/${entry.runtimeName}`) return false;
  const [oldPackage, newPackage] = await Promise.all([
    readBundledSkillPackage(previous, entry.runtimeName),
    readBundledSkillPackage(source, entry.runtimeName),
  ]);
  return Boolean(oldPackage && newPackage &&
    oldPackage.name === newPackage.name && oldPackage.version !== newPackage.version);
}

async function reconcileHermesSkillLink(
  entry: ProprioSkillEntry,
  target: string,
  companyId: string,
): Promise<void> {
  const current = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const source = path.resolve(entry.source);
  if (!current) {
    await fs.symlink(source, target);
    return;
  }
  const conflict = new Error(
    `Cannot reconcile Hermes skill "${entry.key}" because ${target} is occupied by another installation.`,
  );
  if (!current.isSymbolicLink()) throw conflict;

  const link = await fs.readlink(target);
  const previous = path.resolve(path.dirname(target), link);
  if (previous === source) return;
  if (!await ownsPreviousSkillLink(entry, companyId, source, previous)) throw conflict;

  // Prepare the new link on the same filesystem so replacement leaves no gap.
  const staging = await fs.mkdtemp(path.join(path.dirname(target), ".proprio-skill-"));
  try {
    const replacement = path.join(staging, "link");
    await fs.symlink(source, replacement);
    if (await fs.readlink(target) !== link) throw conflict;
    await fs.rename(replacement, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function reconcileHermesProprioSkills(
  config: Record<string, unknown>,
  companyId: string,
  requestedDesiredSkills?: string[],
): Promise<string[]> {
  const availableEntries = await readProprioRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = requestedDesiredSkills
    ? Array.from(new Set([
        ...resolveLegacyProprioDesiredSkillNames({}, availableEntries),
        ...requestedDesiredSkills,
      ]))
    : resolveLegacyProprioDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const skillsHome = path.join(resolveHermesHome(config), "skills");
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key) || isProprioSkillSourceMissing(entry)) continue;
    const target = path.join(skillsHome, entry.runtimeName);
    await reconcileHermesSkillLink(entry, target, companyId);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available || desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return desiredSkills;
}

export async function syncHermesSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  await reconcileHermesProprioSkills(ctx.config, ctx.companyId, desiredSkills);
  return buildHermesSkillSnapshot(ctx.config);
}

export function resolveHermesDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  return resolveLegacyProprioDesiredSkillNames(config, availableEntries);
}
