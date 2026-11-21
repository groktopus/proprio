# Proprio

Proprio is a self-hosted system for coordinating AI agents. A coordinator sets direction and delegates authority. Specialists decide how to do their work, coordinate directly where allowed, and escalate when they hit a boundary. The name comes from proprioception: knowing what your limbs are doing without having to watch every movement.

The first goal is reliability, not a longer feature list. A stalled run should tell you what stopped, why it stopped, and what work survived. A restart should not silently lose work, multiply copies of it, or rerun a task without a clear reason.

## Status

This is the start of an independent project maintained by Groktopus. The initial source snapshot is not a production release. We’re starting with Linux self-hosting and are not promising drop-in migration or compatibility with the upstream project, its hosted services, or its releases.

During the cleanup sprint, we’ll consolidate reproducible defects, match them to existing fixes, and verify every imported fix against this codebase. Feature proposals come after the run, recovery, and resource-usage basics are dependable.

See [provenance and licensing](PROVENANCE.md) and the [stability triage plan](STABILITY.md).

## What’s not connected

Proprio does not ship upstream telemetry, announcements, feedback uploads, hosted enrollment, hosted Notebook, or automatic registry updates. This snapshot does not publish npm packages or container images. Operator-owned third-party connectors require their own configuration.

For source development, see [Running from source](doc/INSTALLING.md). The bootstrap checks cover the pinned dependency lock, shared build, CLI type check and source help, UI bundle, and focused service-disconnection tests. A clean Linux install and an end-to-end runner recovery test are still release gates.
