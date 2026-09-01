#!/usr/bin/env bash
# Tarayici otomasyonu icin playwright-core + Chromium'u runtime/ altina kurar.
#
# ISTEGE BAGLI: uygulamanin geri kalani bu olmadan calisir. Pakete gomulmez
# cunku Chromium ~150 MB ve kullanicilarin cogu tarayici otomasyonu istemiyor.
# Kurulum sisteme degil runtime/engines/playwright altina yapilir; silmek
# klasoru silmek demek.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT/runtime/engines/playwright"
BROWSERS="$TARGET/browsers"
CORE="$TARGET/node_modules/playwright-core"

# Once tasinabilir Node'un npm'i; sistemde npm olmasi gerekmiyor.
if [[ -x "$ROOT/runtime/node/bin/npm" ]]; then
  NPM="$ROOT/runtime/node/bin/npm"
  NODE="$ROOT/runtime/node/bin/node"
elif command -v npm >/dev/null 2>&1; then
  NPM="npm"
  NODE="node"
else
  echo "  [playwright] npm bulunamadi. Once: bash scripts/setup/fetch-node.sh" >&2
  exit 1
fi

if [[ -d "$CORE" && -d "$BROWSERS" ]]; then
  echo "  [playwright] zaten kurulu: $TARGET"
  exit 0
fi

mkdir -p "$TARGET"
# Kendi package.json'i: kurulum uygulamanin bagimliliklarina karismasin.
if [[ ! -f "$TARGET/package.json" ]]; then
  printf '{\n  "name": "studio-playwright",\n  "private": true\n}\n' > "$TARGET/package.json"
fi

echo "  [playwright] playwright-core kuruluyor..."
(cd "$TARGET" && "$NPM" install --no-audit --no-fund --loglevel=error playwright-core)

echo "  [playwright] Chromium indiriliyor (~150 MB)..."
PLAYWRIGHT_BROWSERS_PATH="$BROWSERS" "$NODE" "$CORE/cli.js" install chromium

echo "  [playwright] hazir: $TARGET"
