# Secure engineering

Review these boundaries when a change moves data or authority between actors.
Record the relevant boundary, enforcement point, denial test, expected audit
evidence, and owner of any residual risk in the pull request.

| Boundary | Required behavior and evidence |
| --- | --- |
| Browser or CLI to company API | Resolve the actor and company on the server. Deny an unrelated company or missing permission without disclosing protected data. Check permitted mutation audit and restricted audit exports. See [issue privacy](ISSUE-PRIVACY.md) and [deployment modes](DEPLOYMENT-MODES.md). |
| Agent to workspace, runner, and secrets | Resolve capability, run identity, company, workspace, and secret binding before dispatch. Verify that a denied operation allocates no target, exposes no material, or leaves no durable side effect as applicable. See [low-trust presets](LOW-TRUST-PRESETS.md) and [runner API tools](runner-api-tools.md). |
| Connector and webhook to Core | Authenticate provider events and enforce company scope, resource filters, and current grants at execution time. Verify that rejected requests produce no provider action and retained diagnostics redact sensitive data. See the [connections threat model](connections/SECURITY-THREAT-MODEL.md). |
| Plugins and adapters to host and runtime | Verify installation authority, trusted source, and runtime capability scopes. Verify that a rejected install creates no plugin or runtime state. See [harness availability](harness-availability.md). |
| Operational data to backups and logs | Bound access to audit, transcripts, exports, and restored data. Verify that ordinary readers cannot recover protected content and that privileged exports record the actor. See [database backups](database-backups.md) and [run evidence storage](run-evidence-storage.md). |

Content checks supplement the agent's capability and approval checks. External
content cannot grant authority. See [prompt injection prevention](prompt-injection-prevention.md)
and [MCP access governance](MCP-ACCESS-GOVERNANCE.md).

## Required regression checks

The required smoke job runs named cases for company scope, audit access and
export, CLI credential lifecycle, denied plugin installation, revoked access
before a queued email send, low-trust secret bindings, and runner company
scope and credential metadata validation.

With the workspace dependencies prepared, run the same cases locally.

```sh
node scripts/ci/run-security-regressions.mjs
```

The check requires each named case to report a pass. The database cases need a
working local PostgreSQL fixture. See [CI workflows](ci-workflows.md).

## Private alert triage

The repository maintainer owns intake from [private reporting](../SECURITY.md)
and GitHub scanning. Track alert dispositions in the restricted scanner queue
or a private tracker. Group alerts by shared cause and confirm affected versions
and reachable behavior. Record owner, severity, disposition, review date, and
fix evidence. Escalate confirmed critical issues promptly. Aim to disposition
new scanner-rated critical alerts within seven calendar days. Review exceptions
on their recorded date. Once the existing backlog has a reviewed baseline,
configure a merge rule for newly introduced critical and high findings.

Review alert age, executed required-check coverage, trust-boundary regression
coverage, and release evidence coverage monthly. See the [release checklist](RELEASE-CHECKLIST.md)
for the evidence needed to support a release.
