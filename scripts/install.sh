#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' 'Proprio has no published installer yet.' 'Use a local source checkout and the setup in README.md.' >&2
case "${1:-}" in
  -h|--help) exit 0 ;;
  *) exit 1 ;;
esac
