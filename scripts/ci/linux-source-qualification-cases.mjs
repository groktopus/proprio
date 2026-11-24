import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertRequiredVitestTests } from "./assert-required-vitest-tests.mjs";

export const requiredCases = {
  restore: {
    'packages/db/src/backup-lib.test.ts': [
      'restores ordinary-table CHECK, exclusion and NULLS NOT DISTINCT constraints with pg_dump',
    ],
  },
  runner: {
    'packages/proprio-runner/src/live/runnerd-restart-continuation.test.ts': [
      'adopts the in-flight turn when a restart lands just after turn.start (t77)',
      'finalizes the durable proposed result when the runner and provider die before the turn terminal',
    ],
  },
  controller: {
    'server/src/services/native-runtime/native-safe-replacement.test.ts': [
      'preserves saved work and a queued request at a controlled recovery boundary (verified)',
      'preserves saved work and a queued request at a controlled recovery boundary (unproven)',
      'preserves saved work and a queued request at a controlled recovery boundary (unknown_action)',
      'cancels a durable native retry even when its previous provider is already failed',
    ],
  },
  integration: {
    'server/src/services/native-runtime/proprio-runner-real-server.integration.test.ts': [
      'runs Rust runnerd through Proprio PRP and reads the real bound task',
    ],
    'server/src/services/native-runtime/native-codex-runner.integration.test.ts': [
      'returns a durable result and resumes the provider session on the next run',
    ],
    'server/src/services/native-runtime/native-sandbox-disk-full.test.ts': [
      'names the full disk and stops instead of retrying the same work',
    ],
    'server/src/services/workspace-recovery-disk-full.test.ts': [
      'ends recovery at the first full-disk save with a named cause and a Retry that saves and applies the accepted result without a new turn',
    ],
  },
};

export function qualificationReportPath(directory, name) {
  if (!Object.hasOwn(requiredCases, name)) throw new Error(`Unknown qualification case group ${name}`);
  return join(directory, `durable-work-${name}.json`);
}

export function assertQualificationCases(directory, name) {
  const report = JSON.parse(readFileSync(qualificationReportPath(directory, name), "utf8"));
  assertRequiredVitestTests(report, requiredCases[name]);
}

export function summarizeQualificationCases(directory) {
  return Object.entries(requiredCases).flatMap(([name, files]) => {
    let reports = [];
    try {
      const parsed = JSON.parse(readFileSync(qualificationReportPath(directory, name), "utf8"));
      if (Array.isArray(parsed.testResults)) reports = parsed.testResults;
    } catch {
      // A prerequisite can stop the lane before producing its report.
    }
    return Object.entries(files).flatMap(([file, titles]) => {
      const matches = reports.filter(entry => entry.name?.replaceAll("\\", "/").endsWith(`/${file}`));
      const tests = matches.length === 1 ? (matches[0].assertionResults ?? []) : [];
      return titles.map(title => {
        const matchingTests = tests.filter(test => test.title === title || test.fullName === title);
        const result = matchingTests.length === 1 ? matchingTests[0].status : "incomplete";
        const outcome = ["pending", "skipped", "todo", "disabled"].includes(result) ? "skipped"
          : ["passed", "failed"].includes(result) ? result : "incomplete";
        return `- ${outcome} · ${title}`;
      });
    });
  }).join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, directory, ...groups] = process.argv.slice(2);
  if (command === "check") groups.forEach(group => assertQualificationCases(directory, group));
  else if (command === "path") console.log(qualificationReportPath(directory, groups[0]));
  else if (command === "summary") console.log(summarizeQualificationCases(directory));
  else throw new Error("Use check, path, or summary for the qualification reports.");
}
