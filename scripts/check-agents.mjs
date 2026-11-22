#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Reuse the CommonMark parser already declared by the UI workspace. This check
// runs after the workspace install; it needs no UI build and adds no dependency.
const uiRequire = createRequire(new URL("../ui/package.json", import.meta.url));
const { fromMarkdown } = await import(uiRequire.resolve("mdast-util-from-markdown"));

function* linkTargets(node) {
  if (["link", "image", "definition"].includes(node.type)) yield node.url;
  for (const child of node.children ?? []) yield* linkTargets(child);
}

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findAgentsFiles(directory, results = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) findAgentsFiles(fullPath, results);
    else if (entry.isFile() && entry.name === "AGENTS.md") results.push(fullPath);
  }
  return results;
}

export function validateAgentsFile(filePath, root = REPOSITORY_ROOT) {
  const content = readFileSync(filePath, "utf8");
  const errors = [];
  const relativePath = path.relative(root, filePath);

  if (!content.trim()) errors.push(`${relativePath}: file is empty`);

  for (const rawTarget of linkTargets(fromMarkdown(content))) {
    const target = rawTarget.split(/[?#]/, 1)[0];
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(target);
    } catch {
      errors.push(`${relativePath}: invalid encoded link target ${JSON.stringify(target)}`);
      continue;
    }
    const resolvedTarget = path.resolve(path.dirname(filePath), decodedTarget);
    if (!existsSync(resolvedTarget)) {
      errors.push(`${relativePath}: broken link target ${JSON.stringify(target)}`);
    }
  }
  return errors;
}

export function validateRepositoryAgents(root = REPOSITORY_ROOT) {
  const files = findAgentsFiles(root);
  return files.flatMap((filePath) => validateAgentsFile(filePath, root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateRepositoryAgents();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Validated ${findAgentsFiles(REPOSITORY_ROOT).length} AGENTS.md files and their local links.`);
  }
}
