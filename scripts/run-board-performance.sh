#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

mkdir -p test-results
perf_home=$(mktemp -d "$PWD/test-results/board-perf-instance.XXXXXXXX")
cleanup() { rm -rf -- "$perf_home"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

PROPRIO_COLLECTION_PERF_CI_HOME="$perf_home" pnpm exec playwright test \
  --config tests/perf/collections/playwright.ci.config.ts "$@"
