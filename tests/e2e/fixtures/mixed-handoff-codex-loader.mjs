// Pin the command before test-drive starts the isolated controller.
import { installCodexFixtureResolver } from "./codex-fixture-resolver.mjs";

installCodexFixtureResolver(process.env.MIXED_HANDOFF_CODEX_COMMAND, "Mixed Case handoff");
