// The installed Codex dependency takes precedence over PATH. The disposable
// test controller must use the protocol fixture, even during source startup.
import { accessSync, constants, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// The mixed Case test copies this module next to its generated provider.
// Recovery loads it from the source tree next to the checked-in recovery-bin.
const generatedCommand = new URL("./codex", import.meta.url);
const command = fileURLToPath(existsSync(generatedCommand)
  ? generatedCommand
  : new URL("./recovery-bin/codex", import.meta.url));
accessSync(command, constants.X_OK);
registerHooks({
  load(url, context, nextLoad) {
    if (/\/packages\/proprio-runner\/(src|dist)\/drivers\/codex\/codex-command\.(js|ts)$/.test(url)) {
      return { format: "module", shortCircuit: true,
        source: `export const resolveCodexCommand = () => ${JSON.stringify(command)}; export const resolvePinnedCodexCommand = resolveCodexCommand;` };
    }
    return nextLoad(url, context);
  },
});
