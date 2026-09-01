#!/usr/bin/env bash
# Motor kurulumu (macOS + Linux): fetch-engine.mjs sarmalayicisi.
#
# Isin tamami fetch-engine.mjs'de; bu betigin tek isi calistiracak bir Node
# bulmak. Sistemde Node olmayabilir, o yuzden once tasinabilir olani indiririz.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE="$ROOT/runtime/node/bin/node"

if [[ ! -x "$NODE" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE="$(command -v node)"
  else
    bash "$ROOT/scripts/setup/fetch-node.sh"
    NODE="$ROOT/runtime/node/bin/node"
  fi
fi

exec "$NODE" "$ROOT/scripts/setup/fetch-engine.mjs" "$@"
