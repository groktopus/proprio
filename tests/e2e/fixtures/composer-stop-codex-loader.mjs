// The installed Codex dependency takes precedence over PATH.
import { installCodexFixtureResolver } from "./codex-fixture-resolver.mjs";

installCodexFixtureResolver(process.env.PROPRIO_STOP_CODEX_COMMAND, "Composer Stop");
