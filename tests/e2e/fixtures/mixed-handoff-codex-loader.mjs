// The installed Codex dependency takes precedence over PATH. The disposable
// test controller must use the protocol fixture, even during source startup.
import { accessSync, constants } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const command = fileURLToPath(new URL("./codex", import.meta.url));
accessSync(command, constants.X_OK);

export function resolveCodexCommand() {
  return command;
}

export const resolvePinnedCodexCommand = resolveCodexCommand;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (/\/packages\/proprio-runner\/(src|dist)\/drivers\/codex\/codex-command\.(js|ts)$/.test(result.url)) {
      return { url: import.meta.url, shortCircuit: true };
    }
    return result;
  },
});
