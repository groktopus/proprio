# Release readiness

No upstream release workflow is enabled. Release readiness will require a supported source build, controlled dependency artifacts and isolation/recovery tests.

See the [bootstrap status](../README.md) for what is available in this repository.

## Evidence before a supported Linux release

- Record the release source SHA and its successful Linux source qualification
  run. Record which runner, adapters, installation methods, and host
  architectures the release supports.
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
