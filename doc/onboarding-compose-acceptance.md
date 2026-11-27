# Authenticated Compose onboarding fixture

This opt-in check uses the existing Docker smoke image and the actual public
API/browser. Its Codex command is a controlled local fixture: it verifies that
the application invokes the configured CLI and reports the selected model,
but it does not contact OpenAI or establish that a genuine provider credential
is accepted. A separate run with a real Codex account is required for that.

```sh
export DATA_DIR="$(mktemp -d)"
export SMOKE_METADATA_FILE="$(mktemp)"
export SMOKE_LOG_FILE="$(mktemp)"
SMOKE_DETACH=true \
PROPRIO_DEPLOYMENT_MODE=authenticated \
PROPRIO_DEPLOYMENT_EXPOSURE=public \
SMOKE_ONBOARDING_CODEX_FIXTURE=true \
SMOKE_SKIP_BUILD=true \
bash scripts/docker-onboard-smoke.sh
set -a
. "$SMOKE_METADATA_FILE"
set +a
export SMOKE_DATA_DIR="$DATA_DIR"
export SMOKE_LOG_FILE
pnpm exec playwright test --config tests/e2e/playwright-docker-onboard.config.ts
```

`SMOKE_SKIP_BUILD=true` requires an already-built `proprio-onboard-smoke`
image. `IMAGE_NAME` already accepts an explicit local tag or an exact
`repository/image@sha256:...` reference. Pull or build and tag the image before
running this script; the script checks that exact image and does not build it.
For source qualification, that image must contain the app built from the exact
PR revision. The default Dockerfile installs the published npm package, so a
version tag alone cannot qualify unpublished source.

The Playwright global teardown captures container logs and removes the app and
provider-mock containers; the data directory and metadata remain for
inspection. Do not reuse production data for this test.
