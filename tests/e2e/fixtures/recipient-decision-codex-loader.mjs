import { installCodexFixtureResolver } from "./codex-fixture-resolver.mjs";

installCodexFixtureResolver(process.env.RECIPIENT_DECISION_CODEX_COMMAND, "Recipient decision restart");
