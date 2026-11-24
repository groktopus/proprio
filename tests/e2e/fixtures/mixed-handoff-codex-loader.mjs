// The installed Codex dependency takes precedence over PATH. The disposable
// test controller must use the protocol fixture, even during source startup.
import { accessSync, constants } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const command = process.env.PROPRIO_TEST_CODEX_FIXTURE
  ?? fileURLToPath(new URL("./codex", import.meta.url));
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
