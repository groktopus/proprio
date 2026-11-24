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

Focused Node 24 tests used isolated PostgreSQL. The reconstruction test exercised the authenticated controller with a process adapter and synthetic MCP target. The export and dispatch tests also passed with the two audit branches combined locally. Repeat the applicable checks through the same entry points on the integrated candidate. Record commands, revision, environment, results and links. Required candidate CI typecheck, tests and build must pass. Record the evidence separately for each runner, connector and recovery mode covered by the release. [Reconstruction](https://github.com/groktopus/proprio/pull/368)

The release decision depends on the following checks.

1. Record candidate SHA, commit range/changelog, configuration, runner, connector, evidence visibility and retention settings. Confirm historical policy attribution, authority changes/revocation, and company/private-task permissions.
2. Exercise multi-page export, interrupted delivery, watermark recovery, deletion and older restore. Confirm permitted evidence remains available, excluded evidence stays inaccessible, and gaps are conspicuous.
3. Independently inspect synthetic approved, denied and interrupted attempts. Verify denial has no target effect and reconcile ambiguous effects before retry. State the exact paths covered.
4. Record the restore rehearsal, known-good revision, operator, recovery verification, observation window, backlog and remaining risks. Obtain named engineering/QA, operator, product/docs, governance and independent reviewer sign-offs before the release maintainer records go/no-go.

## Lock and provenance hold

The reviewed source-SDK provenance report records a lock identity that does not match the dependency lock currently present on `main` after the pre-existing merged [#125 change](https://github.com/groktopus/proprio/pull/125). The report remains evidence for the revision it reviewed. Before trusted qualification of source-SDK provenance work (including #358 and #363), a maintainer must approve a lock refresh and the affected provenance checks must be rerun against the refreshed, exact candidate.

## Hold, recovery and resume

Hold expansion for missing decision/dispatch/terminal evidence, authority mismatch, private evidence exposure, an unresolved target effect, a source-epoch mismatch, or a stale lock/provenance identity. Pause affected writes or exports as appropriate, preserve evidence allowed by current retention policy, retain the external archive/checkpoint, and reconcile target effects and deletion obligations before retry or resume. Do not blindly resend an action with an unresolved dispatch intent. Rehearse compatible restore or roll-forward, record the known-good revision and decision owner, then rerun checks on the resumed candidate.

The recovery and audit work is tracked in [#150 restore reconciliation](https://github.com/groktopus/proprio/pull/361), [#206 capture/export/restore qualification](https://github.com/groktopus/proprio/pull/353), [#360 checkpointed export](https://github.com/groktopus/proprio/pull/360), [#369 older-restore export rehearsal](https://github.com/groktopus/proprio/pull/369), [#366 direct dispatch receipt](https://github.com/groktopus/proprio/pull/366), [#370 approved dispatch receipt](https://github.com/groktopus/proprio/pull/370), and [#368 end-to-end reconstruction](https://github.com/groktopus/proprio/pull/368). Preserve external archive evidence independently of application restore state; the archive/checkpoint must be reconciled with the current source epoch and deletion obligations before delivery resumes.

## Related public PRs

- Governance evidence and commentary defaults. [#351](https://github.com/groktopus/proprio/pull/351) [#352](https://github.com/groktopus/proprio/pull/352)
- Older restore deletion reconciliation. [#361](https://github.com/groktopus/proprio/pull/361)
- Audit delivery design, capture, export and restore. [#353](https://github.com/groktopus/proprio/pull/353) [#359](https://github.com/groktopus/proprio/pull/359) [#360](https://github.com/groktopus/proprio/pull/360) [#362](https://github.com/groktopus/proprio/pull/362) [#366](https://github.com/groktopus/proprio/pull/366) [#369](https://github.com/groktopus/proprio/pull/369) [#370](https://github.com/groktopus/proprio/pull/370)
- Run visibility and historical provenance. [#354](https://github.com/groktopus/proprio/pull/354) [#358](https://github.com/groktopus/proprio/pull/358) [#363](https://github.com/groktopus/proprio/pull/363)
- Independent authority review and action reconstruction. [#357](https://github.com/groktopus/proprio/pull/357) [#368](https://github.com/groktopus/proprio/pull/368)
