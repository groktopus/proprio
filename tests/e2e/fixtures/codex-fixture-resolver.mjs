import { accessSync, constants } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute } from "node:path";

let command;

export function resolveCodexCommand() {
  return command;
}

export const resolvePinnedCodexCommand = resolveCodexCommand;

export function installCodexFixtureResolver(configuredCommand, fixtureName) {
  if (process.env.NODE_ENV !== "test" || !configuredCommand || !isAbsolute(configuredCommand)) {
    throw new Error(`${fixtureName} requires an absolute fixture command in NODE_ENV=test`);
  }
  accessSync(configuredCommand, constants.X_OK);
  command = configuredCommand;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (/\/packages\/proprio-runner\/(src|dist)\/drivers\/codex\/codex-command\.(js|ts)$/.test(result.url)) {
        return { url: import.meta.url, shortCircuit: true };
      }
      return result;
    },
  });
}
