export function parseGitHubRepository(repoUrl: string | null | undefined) {
  if (!repoUrl) return null;
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/|ssh:\/\/git@(?:www\.)?github\.com\/|git@(?:www\.)?github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1]!.toLowerCase(), repo: match[2]!.toLowerCase() };
}
