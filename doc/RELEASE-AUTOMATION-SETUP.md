# Release automation

Linux source prereleases use a maintainer-operated GitHub release command and
an exact-revision Linux qualification run. See the [source release runbook](RELEASING.md).

The maintainer-dispatched [Linux image workflow](LINUX-IMAGE-RELEASE.md) builds
one production Compose image, signs its build provenance and SBOM, and promotes
the tested digest after qualification. It publishes to GitHub Container Registry.

The repository has no npm trusted publisher or automatic deployment workflow.
