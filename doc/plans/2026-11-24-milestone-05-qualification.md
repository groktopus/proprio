# Milestone 05 qualification handoff

This handoff records local evidence and the remaining gates for [release plan #223](https://github.com/groktopus/proprio/issues/223). The milestone outcome is an independent reconstruction of a consequential managed action from task and approval through effective policy/runtime to the observed effect, including interruption.

## Candidate record

- Candidate SHA and commit range are pending.
- The qualification owner and deployment are pending.
- Independent review and governance sign-off are pending.
- The target date and observation window are pending.
- Record the configuration, runner, synthetic connector, visibility and retention settings for the selected candidate.

The referenced work was open on November 24, 2026. Check each merge and its exact head before selecting a qualification candidate.

## Evidence and qualification still required

Focused Node 24 tests used isolated PostgreSQL. The reconstruction test exercised the authenticated controller with a process adapter and synthetic MCP target. The reconstruction, checkpointed export, older restore, and direct and approved dispatch tests passed with the audit and provenance changes combined locally. The fixture observed one approved effect, zero denied effects, and an interrupted response with an effect visible in the synthetic target ledger. Repeat the applicable checks through the same entry points on the integrated candidate. Record commands, revision, environment, results and links. Required candidate CI typecheck, tests and build must pass. Record the evidence separately for each runner, connector and recovery mode covered by the release. [Reconstruction](https://github.com/groktopus/proprio/pull/368)

The trace restore rehearsal also passed on Node 24.22.1 with an isolated PostgreSQL instance and loopback MinIO `RELEASE.2025-09-07T16-13-09Z`. The test restored a database row with its old local trace filename, created its migrated object journal, and applied the deletion manifest through the CLI. It verified removal of the local bytes and active ciphertext, a durable database tombstone, and rejection by the object journal. The deployment's object-version retention and candidate restore still require verification. [Restore rehearsal](https://github.com/groktopus/proprio/pull/361#issuecomment-7145834381)

Both Compose layouts reached the reconciliation CLI before application startup. The quickstart test also verified that a missing cluster fails without initialization and an existing embedded PostgreSQL cluster listens on loopback and shuts down. The Compose tests used cached runtime images, the PR source, and empty manifests. Repeat the restore with the selected image and deployment configuration. [Compose evidence](https://github.com/groktopus/proprio/pull/361#issuecomment-7146200058)

The export freezes the IDs and checksum of visible records in the declared capture window. It detects a missing or newly restricted member when it reads a page. The checksum cannot detect an event that was absent before the snapshot. Initial capture covers decisions recorded by the managed gateway policy transaction. Read-only virtual tool discovery is outside that capture path. The approval and dispatch slices add evidence for the documented remote MCP route. Record the deployed producer coverage alongside each archive checkpoint. [Capture boundary](https://github.com/groktopus/proprio/pull/359) [Export contract](https://github.com/groktopus/proprio/pull/360)

The release decision depends on the following checks.

1. Record candidate SHA, commit range/changelog, configuration, runner, connector, evidence visibility and retention settings. Confirm historical policy attribution, authority changes/revocation, and company/private-task permissions.
2. Exercise multi-page export, interrupted delivery, watermark recovery, deletion and older restore. Confirm permitted evidence remains available, excluded evidence stays inaccessible, and gaps are conspicuous.
3. Independently inspect synthetic approved, denied and interrupted attempts. Verify denial has no target effect and reconcile ambiguous effects before retry. State the exact paths covered.
4. Record the restore rehearsal, known-good revision, operator, recovery verification, observation window, backlog and remaining risks. Obtain named engineering/QA, operator, product/docs, governance and independent reviewer sign-offs before the release maintainer records go/no-go.

## Lock and provenance hold

The reporting lock guard rejects the lock on `main` at `6e6ebf51`. The committed lock SHA-256 is `535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337`, while the report policy lists `f54797a4c415df7a40ec6550479a903cb33ba4225921eefcbe7e7d5fb7e7dc8e` for both input and output. The intervening change pins `oxlint@1.94.0` and its platform packages. [Dependency change](https://github.com/groktopus/proprio/pull/125)

The release maintainer must review the lock change and arrange the trusted reporting lock refresh. The workflow list for this repository exposed no active lock refresh workflow when checked on November 24, 2026. Then regenerate the public input pins, run the trusted SDK checks for #358 and #363, and record the results for the exact candidate. [Runner operations](https://github.com/groktopus/proprio/blob/6e6ebf51cb0cf214375523171f80f19d14da073f/tests/runner-e2e/OPERATIONS.md#hosted-report-dependencies)

## Hold, recovery and resume

Hold expansion for missing decision/dispatch/terminal evidence, authority mismatch, private evidence exposure, an unresolved target effect, a source-epoch mismatch, or a stale lock/provenance identity. Pause affected writes or exports as appropriate, preserve evidence allowed by current retention policy, retain the external archive/checkpoint, and reconcile target effects and deletion obligations before retry or resume. Do not blindly resend an action with an unresolved dispatch intent. Rehearse compatible restore or roll-forward, record the known-good revision and decision owner, then rerun checks on the resumed candidate.

The recovery and audit work is tracked in [#150 restore reconciliation](https://github.com/groktopus/proprio/pull/361), [#206 capture/export/restore qualification](https://github.com/groktopus/proprio/pull/353), [#360 checkpointed export](https://github.com/groktopus/proprio/pull/360), [#369 older-restore export rehearsal](https://github.com/groktopus/proprio/pull/369), [#366 direct dispatch receipt](https://github.com/groktopus/proprio/pull/366), [#370 approved dispatch receipt](https://github.com/groktopus/proprio/pull/370), and [#368 end-to-end reconstruction](https://github.com/groktopus/proprio/pull/368). Preserve external archive evidence independently of application restore state; the archive/checkpoint must be reconciled with the current source epoch and deletion obligations before delivery resumes.

## Related public PRs

- Governance evidence and commentary defaults. [#351](https://github.com/groktopus/proprio/pull/351) [#373](https://github.com/groktopus/proprio/pull/373) [#352](https://github.com/groktopus/proprio/pull/352)
- Older restore deletion reconciliation. [#361](https://github.com/groktopus/proprio/pull/361)
- Audit delivery design, capture, export and restore. [#353](https://github.com/groktopus/proprio/pull/353) [#359](https://github.com/groktopus/proprio/pull/359) [#360](https://github.com/groktopus/proprio/pull/360) [#362](https://github.com/groktopus/proprio/pull/362) [#366](https://github.com/groktopus/proprio/pull/366) [#369](https://github.com/groktopus/proprio/pull/369) [#370](https://github.com/groktopus/proprio/pull/370)
- Run visibility and historical provenance. [#354](https://github.com/groktopus/proprio/pull/354) [#358](https://github.com/groktopus/proprio/pull/358) [#363](https://github.com/groktopus/proprio/pull/363)
- Independent authority review and action reconstruction. [#357](https://github.com/groktopus/proprio/pull/357) [#368](https://github.com/groktopus/proprio/pull/368)
