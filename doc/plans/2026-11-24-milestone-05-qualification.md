# Milestone 05 qualification handoff

Status: **planning handoff; not a release decision**. This record summarizes the evidence and gates for [release plan #223](https://github.com/groktopus/proprio/issues/223). The milestone outcome is an independent reconstruction of a consequential managed action from task and approval through effective policy/runtime to the observed effect, including interruption.

## Candidate record

- Candidate SHA / commit range: **unset**
- Qualification owner / deployment: **unset**
- Independent review and governance sign-off: **unset**
- Target ship date / observation window: **unset**
- Configuration, runner, synthetic connector, visibility and retention settings: **to record for the selected candidate**

Do not select or promote a candidate from this handoff. The referenced work is still under review; linked PR state was checked on 2026-11-24 and all #351–#370 were open. Recheck status, merge base and exact heads before composing the qualification candidate.

## Evidence and qualification still required

The PR evidence is scoped local evidence, not candidate qualification. Focused tests and synthetic fixtures cited by the changes ran on Node 24 (several specify 24.22.1) with isolated PostgreSQL; #368 uses an authenticated local process run and synthetic MCP target, not a model account or live provider. Repeat the applicable normal-entry-point checks on the exact integrated candidate and record commands, revision, environment, results and links. Required candidate CI typecheck, tests and build must pass. The local evidence does not qualify other runners, connectors, production PITR, unimplemented producer paths, or broad deployment policy.

Before go/no-go, satisfy #223's gates:

1. Record candidate SHA, commit range/changelog, configuration, runner, connector, evidence visibility and retention settings. Confirm historical policy attribution, authority changes/revocation, and company/private-task permissions.
2. Exercise multi-page export, interrupted delivery, watermark recovery, deletion and older restore. Confirm permitted evidence remains available, excluded evidence stays inaccessible, and gaps are conspicuous.
3. Independently inspect synthetic approved, denied and interrupted attempts. Verify denial has no target effect; reconcile ambiguous effects before retry. State the exact paths covered.
4. Record the restore rehearsal, known-good revision, operator, recovery verification, observation window, backlog and remaining risks. Obtain named engineering/QA, operator, product/docs, governance and independent reviewer sign-offs before the release maintainer records go/no-go.

## Lock and provenance hold

The reviewed source-SDK provenance report records a lock identity that does not match the dependency lock currently present on `main` after the pre-existing merged [#125 change](https://github.com/groktopus/proprio/pull/125). Keep that report as evidence of the revision it actually reviewed; do not treat it as proof for the current tree. Before trusted qualification of source-SDK provenance work (including #358 and #363), a maintainer must approve a lock refresh and the affected provenance checks must be rerun against the refreshed, exact candidate. This handoff does not change dependency locks or trust manifests.

## Hold, recovery and resume

Hold expansion for missing decision/dispatch/terminal evidence, authority mismatch, private evidence exposure, an unresolved target effect, a source-epoch mismatch, or a stale lock/provenance identity. Pause affected writes or exports as appropriate, preserve evidence allowed by current retention policy, retain the external archive/checkpoint, and reconcile target effects and deletion obligations before retry or resume. Do not blindly resend an action with an unresolved dispatch intent. Rehearse compatible restore or roll-forward, record the known-good revision and decision owner, then rerun checks on the resumed candidate.

Related recovery and audit work: [#150 restore reconciliation](https://github.com/groktopus/proprio/pull/361), [#206 capture/export/restore qualification](https://github.com/groktopus/proprio/pull/353), [#360 checkpointed export](https://github.com/groktopus/proprio/pull/360), [#369 older-restore export rehearsal](https://github.com/groktopus/proprio/pull/369), [#366 direct dispatch receipt](https://github.com/groktopus/proprio/pull/366), [#370 approved dispatch receipt](https://github.com/groktopus/proprio/pull/370), and [#368 end-to-end reconstruction](https://github.com/groktopus/proprio/pull/368). Preserve external archive evidence independently of application restore state; the archive/checkpoint must be reconciled with the current source epoch and deletion obligations before delivery resumes.

## Related public PRs

These references are open drafts/reviews, not merged candidate contents. Recheck each before integration.

- [#351 governance evidence guide](https://github.com/groktopus/proprio/pull/351) · [#352 proactive commentary opt-in](https://github.com/groktopus/proprio/pull/352) · [#353 managed audit delivery contract](https://github.com/groktopus/proprio/pull/353) · [#354 managed decision read visibility](https://github.com/groktopus/proprio/pull/354)
- [#355 Case recovery history browser test](https://github.com/groktopus/proprio/pull/355) · [#356 milestone 04 rehearsal record](https://github.com/groktopus/proprio/pull/356) · [#357 independent sensitive-authority review](https://github.com/groktopus/proprio/pull/357) · [#358 pinned native runtime evidence](https://github.com/groktopus/proprio/pull/358)
- [#359 transactional initial audit decisions](https://github.com/groktopus/proprio/pull/359) · [#360 checkpointed audit export](https://github.com/groktopus/proprio/pull/360) · [#361 older-restore deletion reconciliation](https://github.com/groktopus/proprio/pull/361) · [#362 transactional approval resolution](https://github.com/groktopus/proprio/pull/362)
- [#363 historical tool-policy provenance](https://github.com/groktopus/proprio/pull/363) · [#364 Case decisions across restart](https://github.com/groktopus/proprio/pull/364) · [#365 dependency diagnosis restart count](https://github.com/groktopus/proprio/pull/365) · [#366 direct MCP dispatch/outcome evidence](https://github.com/groktopus/proprio/pull/366)
- [#367 exhausted dependency diagnosis reload](https://github.com/groktopus/proprio/pull/367) · [#368 interrupted-action reconstruction](https://github.com/groktopus/proprio/pull/368) · [#369 audit retention across older restore](https://github.com/groktopus/proprio/pull/369) · [#370 approved MCP dispatch/outcome evidence](https://github.com/groktopus/proprio/pull/370)
