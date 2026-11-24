# Release readiness

Follow the [source release runbook](RELEASING.md) for Linux prereleases.

## Evidence before a supported Linux release

- Record the candidate SHA and preceding source tag before dispatch. Confirm
  that the candidate is on `main` and that the source diff is reviewed.
- Dispatch Linux source qualification with the candidate as `test_head`
  and the predecessor SHA as `base_sha`. Require an executed passing
  `source-and-runner` job and its unexpired report for that attempt.
- Check managed update and rollback, fresh-target restore, interruption and
  cancellation, disk-pressure diagnostics, and browser task readback. When
  tracked migration SQL changes, check the active-run migration case against
  those same SHAs, elapsed recovery time, and zero observed data loss.
- In the release notes, record the exact SHA and evidence links, installation
  and upgrade steps, supported architecture and storage topology, skipped
  or failed lanes, and any limits on the support claim.
- Run the publication dry run, then publish after the required evidence and
  authorization are in place. Verify the GitHub tag, prerelease, and catalog.

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
