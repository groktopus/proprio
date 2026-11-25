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

Focused Node 24 tests used isolated PostgreSQL. The reconstruction test exercised the authenticated controller with a process adapter and synthetic MCP target. Nine focused tests passed on the local composition `5787f3033f74171744bc5a82abf6a083e7c1ca3a`. They covered reconstruction, historical policy, approved and direct dispatch, atomic capture and approval, checkpointed export beyond the CSV cap, older restore, and private-task/runtime visibility. This composition includes the reviewed policy change from #363 and the reconstruction change from #368. The fixture observed one approved effect, zero denied effects, and an interrupted response with an effect visible in the synthetic target ledger. Repeat the applicable checks through the same entry points on the integrated candidate. Record commands, revision, environment, results and links. Required candidate CI typecheck, tests and build must pass. Record the evidence separately for each runner, connector and recovery mode covered by the release. [Reconstruction](https://github.com/groktopus/proprio/pull/368)

The trace restore rehearsal also passed on Node 24.22.1 with an isolated PostgreSQL instance and loopback MinIO `RELEASE.2025-09-07T16-13-09Z`. The test restored a database row with its old local trace filename, created its migrated object journal, and applied the deletion manifest through the CLI. It verified removal of the local bytes and active ciphertext, a durable database tombstone, and rejection by the object journal. The deployment's object-version retention and candidate restore still require verification. [Restore rehearsal](https://github.com/groktopus/proprio/pull/361#issuecomment-7145834381)

Both Compose layouts reached the reconciliation CLI before application startup. The quickstart test also verified that a missing cluster fails without initialization and an existing embedded PostgreSQL cluster listens on loopback and shuts down. The Compose tests used cached runtime images, the PR source, and empty manifests. Repeat the restore with the selected image and deployment configuration. [Compose evidence](https://github.com/groktopus/proprio/pull/361#issuecomment-7146200058)

The export freezes the IDs and checksum of visible records in the declared capture window. It detects a missing or newly restricted member when it reads a page. The checksum cannot detect an event that was absent before the snapshot. Initial capture covers decisions recorded by the managed gateway policy transaction. Read-only virtual tool discovery is outside that capture path. The approval and dispatch slices add evidence for the documented remote MCP route. Record the deployed producer coverage alongside each archive checkpoint. [Capture boundary](https://github.com/groktopus/proprio/pull/359) [Export contract](https://github.com/groktopus/proprio/pull/360)

- The connected MCP rollback fixture verified that an audit insert failure rolls back the invocation, approval request and rate charge before any provider send. A retry commits one rate charge and one event. The delegated test-call and legacy-plugin paths retain separate rate-accounting behavior. [Gateway rollback](https://github.com/groktopus/proprio/pull/359#issuecomment-7147343987)
- All 16 audit route tests passed on `ebac201b` with disposable PostgreSQL and Node 24.22.1. They exercised 10,037 events, a persisted resume cursor, source epoch rotation, exact archive bytes after an older restore, and loss of visibility on a different page. The API checked all snapshot members before returning page data, count and watermark. [Restore contract](https://github.com/groktopus/proprio/pull/369#issuecomment-7147751483) [Snapshot visibility](https://github.com/groktopus/proprio/pull/374#issuecomment-7147698734)
- A focused export test verified that an orphaned event with a surviving private task cannot reveal its presence through a conflict response. The existing missing-binding fixture still reported incomplete delivery for an eligible event. [Private binding](https://github.com/groktopus/proprio/pull/375)
- All 18 audit route tests passed on `49adcf9d`. A transaction committed after its first export froze. A fresh overlapping snapshot recovered its event, and stable event identity allowed deduplication across a source epoch change. Delays beyond the collector's lookback require separate reconciliation. [Overlapping export](https://github.com/groktopus/proprio/pull/376)
- Three tests on `2b75d9b0` applied the combined migration and checked a task-bound write, a read-only call and the public export projection. The gateway persisted the provider correlation ID before dispatch, committed receipt before completion, and blocked a repeat mutation across a changed run and idempotency key. [Direct dispatch](https://github.com/groktopus/proprio/pull/366#issuecomment-7147826662)
- Five tests and the layered server typecheck passed on `5bd23631`. The approval route and authenticated `tools/call` recorded and settled the approved action under the active claim. A same-agent direct retry with identical arguments, a replacement run, and a new key could not send again after an unresolved approved action. An expired elicitation round and a thrown transport error also preserved the unresolved intent. [Approved dispatch](https://github.com/groktopus/proprio/pull/370)
- On `9ac8fffe`, an independent reviewer matched the exported policy decision, human approval and open dispatch intent for the interrupted action after server recreation. The `complete` field on a page signals that delivery reached the end of the frozen snapshot. The target ledger establishes the actual effect of the interrupted action. [Reconstruction](https://github.com/groktopus/proprio/pull/368)

The latest local composition `b8be6b6f3cb1e1151651abef0f882448a7ec2546` passed
14 focused tests on Linux with Node 24.22.1. It combined the reviewed
reconstruction, independent authority, historical policy, direct and approved
calls, retention and export privacy branches. The fixture used isolated
PostgreSQL and a process adapter against a local synthetic MCP target. It
captured historical policy in the transaction that writes the rate charge and
managed admission record.

GitHub's Linux source qualification passed for reconstruction PR head
`9ac8fffe7fed9114b04ded567802a6381790b0f8` with baseline `6e6ebf51`. It covered
locked install, source and Runner builds, managed update and rollback, a fresh
synthetic task, fresh-target PostgreSQL restore, and interruption recovery. The
run retained its durable-work acceptance report. [Hosted qualification](https://github.com/groktopus/proprio/actions/runs/45517565083)

Fifteen focused tests passed for the historical and runtime provenance stack
at `45866c87`. The authenticated decision route returned the original policy
revision, the admitted Codex fallback model and the pinned skill version after
the skill was updated. The fixture also checked private task and skill visibility
and malformed admission evidence. [Native provenance](https://github.com/groktopus/proprio/pull/358)

The release decision depends on the following checks.

1. Record candidate SHA, commit range/changelog, configuration, runner, connector, evidence visibility and retention settings. Confirm historical policy attribution, authority changes/revocation, and company/private-task permissions.
2. Exercise multi-page export, interrupted delivery, watermark recovery, deletion and older restore. Confirm permitted evidence remains available, excluded evidence stays inaccessible, and gaps are conspicuous.
3. Independently inspect synthetic approved, denied and interrupted attempts. Verify denial has no target effect and reconcile ambiguous effects before retry. State the exact paths covered.
4. Record the restore rehearsal, known-good revision, operator, recovery verification, observation window, backlog and remaining risks. Obtain named engineering/QA, operator, product/docs, governance and independent reviewer sign-offs before the release maintainer records go/no-go.

## Lock and provenance hold

The reporting lock guard rejects the lock on `main` at `6e6ebf51`. The committed lock SHA-256 is `535010469947806e6b8f0edff97bd211ca96b573dccd81dd08556e3f7b43b337`, while the report policy lists `f54797a4c415df7a40ec6550479a903cb33ba4225921eefcbe7e7d5fb7e7dc8e` for both input and output. The intervening change pins `oxlint@1.94.0` and its platform packages. [Dependency change](https://github.com/groktopus/proprio/pull/125)

The release maintainer must review the lock change and arrange the trusted
reporting lock refresh. GitHub has no active refresh workflow at the verified
baseline. The repository owner needs to provide the authorized workflow,
protected environment and installed lockfile bot. Once the trusted refresh
lands, resync public input pins and run the SDK checks for #358 and #363 on
the exact candidate. [Runner operations](../../tests/runner-e2e/OPERATIONS.md#hosted-report-dependencies)

## Hold, recovery and resume

Hold expansion for missing decision/dispatch/terminal evidence, authority mismatch, private evidence exposure, an unresolved target effect, a source-epoch mismatch, or a stale lock/provenance identity. Pause affected writes or exports as appropriate, preserve evidence allowed by current retention policy, retain the external archive/checkpoint, and reconcile target effects and deletion obligations before retry or resume. Do not blindly resend an action with an unresolved dispatch intent. Rehearse compatible restore or roll-forward, record the known-good revision and decision owner, then rerun checks on the resumed candidate.

The recovery and audit work is tracked in [#150 restore reconciliation](https://github.com/groktopus/proprio/pull/361), [#206 capture/export/restore qualification](https://github.com/groktopus/proprio/pull/353), [#360 checkpointed export](https://github.com/groktopus/proprio/pull/360), [#369 older-restore export rehearsal](https://github.com/groktopus/proprio/pull/369), [#366 direct dispatch receipt](https://github.com/groktopus/proprio/pull/366), [#370 approved dispatch receipt](https://github.com/groktopus/proprio/pull/370), and [#368 end-to-end reconstruction](https://github.com/groktopus/proprio/pull/368). Preserve external archive evidence independently of application restore state; the archive/checkpoint must be reconciled with the current source epoch and deletion obligations before delivery resumes.

## Related public PRs

- Governance evidence and commentary defaults. [#351](https://github.com/groktopus/proprio/pull/351) [#373](https://github.com/groktopus/proprio/pull/373) [#352](https://github.com/groktopus/proprio/pull/352)
- Older restore deletion reconciliation. [#361](https://github.com/groktopus/proprio/pull/361)
- Audit delivery design, capture, export and restore. [#353](https://github.com/groktopus/proprio/pull/353) [#359](https://github.com/groktopus/proprio/pull/359) [#360](https://github.com/groktopus/proprio/pull/360) [#362](https://github.com/groktopus/proprio/pull/362) [#366](https://github.com/groktopus/proprio/pull/366) [#369](https://github.com/groktopus/proprio/pull/369) [#370](https://github.com/groktopus/proprio/pull/370) [#374](https://github.com/groktopus/proprio/pull/374) [#375](https://github.com/groktopus/proprio/pull/375)
- Run visibility and historical provenance. [#354](https://github.com/groktopus/proprio/pull/354) [#358](https://github.com/groktopus/proprio/pull/358) [#363](https://github.com/groktopus/proprio/pull/363)
- Independent authority review and action reconstruction. [#357](https://github.com/groktopus/proprio/pull/357) [#368](https://github.com/groktopus/proprio/pull/368)
