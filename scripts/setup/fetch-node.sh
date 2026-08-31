#!/usr/bin/env bash
# Tasinabilir Node.js calisma zamanini runtime/node altina indirir.
# Sisteme hicbir sey kurmaz. Indirilen arsiv SHA256 ile dogrulanir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT/runtime/node"
FALLBACK_VERSION="v24.20.0"

if [[ -x "$TARGET/bin/node" ]]; then
  echo "  [node] zaten kurulu: $("$TARGET/bin/node" -v)"
  exit 0
fi

case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  PLATFORM="linux" ;;
  *) echo "  [node] desteklenmeyen platform: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64)        ARCH="x64" ;;
  *) echo "  [node] desteklenmeyen mimari: $(uname -m)" >&2; exit 1 ;;
esac

echo "  [node] guncel LTS surumu sorgulaniyor..."
VERSION="$(curl -fsSL --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null \
  | tr '}' '\n' | grep -m1 '"lts":"' \
  | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p' || true)"
[[ -z "$VERSION" ]] && VERSION="$FALLBACK_VERSION"
echo "  [node] surum: $VERSION ($PLATFORM-$ARCH)"

ARCHIVE="node-$VERSION-$PLATFORM-$ARCH.tar.gz"
BASE="https://nodejs.org/dist/$VERSION"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "  [node] indiriliyor: $ARCHIVE"
curl -fL --progress-bar -o "$WORK/$ARCHIVE" "$BASE/$ARCHIVE"

echo "  [node] SHA256 dogrulaniyor..."
curl -fsSL -o "$WORK/SHASUMS256.txt" "$BASE/SHASUMS256.txt"
( cd "$WORK" && grep " $ARCHIVE\$" SHASUMS256.txt | shasum -a 256 -c - )

mkdir -p "$TARGET"
tar -xzf "$WORK/$ARCHIVE" -C "$TARGET" --strip-components=1

echo "  [node] hazir: $("$TARGET/bin/node" -v)"
