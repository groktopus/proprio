import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { mergeDiff } from "../../.github/scripts/ci-diff.mjs";

const boardAccessibilityPaths = [
  /^ui\//,
  /^packages\/(?:shared|adapter-utils|adapters|plugins\/sdk)\//,
  /^maps\//,
  /^tests\/(?:board-accessibility|storybook-visual)\//,
  /^scripts\/(?:ci\/board-accessibility-routing(?:\.test)?\.mjs|storybook[-.]|serve-storybook-static\.mjs|check-maps\.mjs|feature-map\.mjs|ensure-plugin-build-deps\.mjs)/,
  /^\.github\/(?:workflows\/stability-smoke\.yml|scripts\/ci-diff\.mjs)$/,
  /^(?:\.nvmrc|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
];

export function requiresBoardAccessibility(changedPaths) {
  return changedPaths.some((path) => boardAccessibilityPaths.some((pattern) => pattern.test(path)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , merge, head] = process.argv;
  const { changed } = mergeDiff(merge, head);
  const applicable = requiresBoardAccessibility(changed);
  console.log(`Board accessibility applicable: ${applicable}. PR head: ${head}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `applicable=${applicable}\n`);
}
