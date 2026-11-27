import { fileURLToPath } from "node:url";
import { installCodexFixtureResolver } from "./codex-fixture-resolver.mjs";

const command = fileURLToPath(new URL("./recovery-bin/codex", import.meta.url));
installCodexFixtureResolver(command, "Execution recovery");
