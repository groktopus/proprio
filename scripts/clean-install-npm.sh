#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PC_INSTALL_DRIVER="${PC_INSTALL_DRIVER:-source}"

PC_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/proprio-clean-install.XXXXXX")"
PC_HOME="$PC_TEST_ROOT/home"
PC_CACHE="$PC_TEST_ROOT/npm-cache"
mkdir -p "$PC_HOME" "$PC_CACHE"
trap 'rm -rf "$PC_TEST_ROOT"' EXIT

export HOME="$PC_HOME"
export PROPRIO_HOME="$PC_HOME/.proprio"
export npm_config_cache="$PC_CACHE"
export npm_config_userconfig="$PC_HOME/.npmrc"
export PATH="$PC_HOME/.local/bin:$PATH"

if [ "$PC_INSTALL_DRIVER" = "published" ]; then
  (cd "$PC_TEST_ROOT" && npx --yes --registry https://registry.npmjs.org proprio install)
else
  (cd "$REPO_ROOT" && pnpm proprio install --yes)
fi

test -x "$PC_HOME/.local/bin/proprio"
test -L "$PROPRIO_HOME/cli/current"
test -f "$PROPRIO_HOME/cli/install.json"
proprio --version

mkdir -p "$PROPRIO_HOME/instances/default"
touch "$PROPRIO_HOME/instances/default/user-data-marker"
(cd "$REPO_ROOT" && pnpm proprio uninstall)

test ! -e "$PROPRIO_HOME/cli"
test ! -e "$PC_HOME/.local/bin/proprio"
test -f "$PROPRIO_HOME/instances/default/user-data-marker"
