import path from "node:path";

const SKILL_VERSION_CACHE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function isSkillVersionCacheId(value: string): boolean {
  return SKILL_VERSION_CACHE_ID.test(value);
}

export function resolveSkillVersionCachePaths(instanceRoot: string, companyId: string, skillId: string, versionId: string) {
  if (![companyId, skillId, versionId].every(isSkillVersionCacheId)) throw new Error("Invalid skill cache identity");
  const root = path.join(instanceRoot, "skills", companyId);
  return {
    root,
    directory: path.join(root, "__versions__", skillId, versionId),
    access: path.join(root, "__version_access__", skillId, `${versionId}.json`),
  };
}
