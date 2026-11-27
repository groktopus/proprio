import { accessSync, constants } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The test copies this loader beside its exit-only Codex executable.
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
