# Release readiness

No upstream release workflow is enabled. Release readiness will require a supported source build, controlled dependency artifacts and isolation/recovery tests.

See the [bootstrap status](../README.md) for what is available in this repository.

## Evidence before a supported Linux release

- Record the release source SHA and its successful Linux source qualification
  run. Record which runner, adapters, installation methods, and host
  architectures the release supports.
- For durable-work changes, retain exact-source acceptance before publishing
  the GitHub source release. `scripts/create-github-release.sh` enforces this
  for calendar releases and `0.0.x-alpha.N`, `0.0.x-beta.N`, and `0.0.x-rc.N`
  prereleases. It checks the candidate against the previous stable tag and
  requires the passing Linux `source-and-runner` job plus the unexpired
  `durable-work-acceptance` report with managed update/rollback,
  fresh-target backup/restore, interruption/restart/cancellation/disk-pressure,
  and browser task-readback evidence. If the candidate diff includes tracked
  migration SQL, the report must also include active-run migration recovery,
  bind both revisions, record recovery time and observed data loss. Otherwise,
  that case must say `not_applicable` with a link to the same run attempt. Every
  case link must point to the validated `groktopus/proprio` Actions run attempt.
  Dispatch Linux source qualification on `main` with `test_head` set to the
  release candidate SHA and `base_sha` set to the previous stable tag SHA; the
  run title records both values as `Source qualification <source SHA> from
  <base SHA>`.
  Missing or skipped evidence blocks release creation and editing. A dry run
  does not publish and can be used before qualification is complete.
- Inventory the root pnpm workspace, the sandbox-provider typecheck workspace,
  the Daytona pnpm workspace, the Rust runner lockfile, the image base digests,
  and downloaded runtime artifacts. Record the versions, digests, and advisory
  dispositions for shipped inputs.
- Build from locked inputs. For each distributed package or image, retain an
  SBOM and build provenance that name its immutable digest. During promotion,
  verify those documents against the artifact and approved build identity.
- Exercise an isolated Linux restore with synthetic data and credentials. Record
  the restore outcome, credential revocation and replacement, and the time to
  recover. Rehearse private advisory intake and operator notification without
  contacting users.
- Record the owner and review date of any residual risks. The Core release
  record links deployment-specific evidence from its owning repository.
