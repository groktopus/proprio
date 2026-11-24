# Storybook Visual Baselines

The visual suite compares built Storybook stories against PNG snapshots stored
outside git. The checked-in manifest at `baseline-manifest.json` pins the
immutable archive URL, SHA-256, byte size, snapshot count, and capture
environment.

## Commands

```sh
pnpm storybook-visual:baseline download
pnpm storybook-visual:baseline verify
pnpm test:storybook-visual
pnpm test:storybook-visual:update
```

`download` fetches the archive, verifies its SHA-256 and byte size, unpacks it to
`tests/storybook-visual/.snapshots/`, and checks the PNG count. The same snapshot
directory can be overridden with `STORYBOOK_VISUAL_SNAPSHOT_DIR`.

## Known Limitation: Linux Baselines

Storybook visual baselines are platform-locked. The checked-in manifest records
the capture environment as `ubuntu-24.04`, and Playwright compares screenshots
with `maxDiffPixels: 0`. Pixel-exact results are only meaningful when local runs
use the same Linux/Ubuntu capture platform as the baseline.

macOS, Windows, and other non-matching local environments can produce
false-positive diffs from font rasterization and subpixel rendering differences.
Use the pinned Linux environment in the **Operator attention visual** workflow
for the operator fixture set described below.

The generic manifest and local commands at the top of this document support a
separately configured archive. The repository does not ship a configured
generic archive or a generic CI comparison workflow.

## Updating Baselines

1. Run `pnpm test:storybook-visual:update` after reviewing intentional visual
   diffs.
2. Run `pnpm storybook-visual:baseline pack` to create
   `tests/storybook-visual/baseline-review/snapshots.tgz`.
3. Upload the archive from a trusted maintainer environment with
   `STORYBOOK_VISUAL_S3_URI=s3://bucket/baselines/storybook-visual/<sha>/snapshots.tgz pnpm storybook-visual:baseline upload`.
4. Copy the printed `snapshotCount` and `archive` fields into
   `baseline-manifest.json`.

Generated snapshots, review bundles, Playwright reports, and downloaded caches
are ignored by git.

## Operator attention test baseline

The **Operator attention visual** workflow uses a fixture-backed Storybook test
instance. It takes no production data or credentials. To capture a candidate,
dispatch the workflow with `capture` enabled or apply the
`storybook-baseline-capture` label to its pull request. Review the eight
screenshots and record the exact source commit, run ID, artifact ID and name, SHA-256,
byte size, and snapshot count in `operator-attention-baseline.json` through a PR.
The candidate is retained in Actions test artifacts for 90 days. Recapture and
review the reference before it expires.

Compare using a regular dispatch or the `operator-attention-visual` PR label. The test
job downloads the pinned archive, verifies its checksum and count, and compares
the four fixtures in both themes. The report retains actual, expected, and diff
screenshots on failure. A deliberate reference mismatch checks that the report contains
all three images. The reviewed reference stays in Actions test artifacts.

For local reproduction on the pinned Linux environment, download the recorded
artifact and unpack the verified archive from the repository root:

```sh
export STORYBOOK_VISUAL_BASELINE_MANIFEST=tests/storybook-visual/operator-attention-baseline.json
pnpm storybook-visual:baseline download --archive ./snapshots.tgz
pnpm storybook-visual:baseline verify
pnpm build-storybook
pnpm exec playwright test operator-attention.spec.ts \
  --config tests/storybook-visual/playwright.config.ts --project stories --workers 1
```
