#!/usr/bin/env bash
# stable-diffusion.cpp motorunu runtime/engines/sd altina indirir.
# Indirilen arsiv GitHub'in bildirdigi SHA256 ile dogrulanir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT/runtime/engines/sd"
REPO="leejet/stable-diffusion.cpp"

if [[ -x "$TARGET/sd-server" ]]; then
  echo "  [sd] zaten kurulu: $TARGET/sd-server"
  exit 0
fi

# Varlik adlari isletim sistemi surumunu icerdigi icin ("Darwin-macOS-26.5.2")
# tam ad yerine kalip eslesmesi yapariz.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PATTERN="bin-Darwin" ;;
  Linux-x86_64)  PATTERN="bin-Linux-Ubuntu-24.04-x86_64.zip" ;;
  *) echo "  [sd] bu platform icin hazir ikili yok: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "  [sd] son surum araniyor ($PATTERN)..."
META="$(curl -fsSL --max-time 30 "https://api.github.com/repos/$REPO/releases?per_page=10")"

read -r ASSET_URL ASSET_NAME ASSET_DIGEST <<EOF2
$(printf '%s' "$META" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const pattern = process.argv[1];
  for (const release of JSON.parse(d)) {
    const asset = (release.assets || []).find((a) => a.name.includes(pattern));
    if (asset) {
      console.log(asset.browser_download_url, asset.name, (asset.digest || "").replace(/^sha256:/, ""));
      return;
    }
  }
  process.exit(3);
});' "$PATTERN")
EOF2

if [[ -z "${ASSET_URL:-}" ]]; then
  echo "  [sd] uygun varlik bulunamadi." >&2
  exit 1
fi

echo "  [sd] indiriliyor: $ASSET_NAME"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fL --progress-bar -o "$WORK/$ASSET_NAME" "$ASSET_URL"

if [[ -n "${ASSET_DIGEST:-}" ]]; then
  echo "  [sd] SHA256 dogrulaniyor..."
  ACTUAL="$(shasum -a 256 "$WORK/$ASSET_NAME" | awk '{print $1}')"
  if [[ "$ACTUAL" != "$ASSET_DIGEST" ]]; then
    echo "  [sd] SHA256 UYUSMUYOR. Beklenen $ASSET_DIGEST, bulunan $ACTUAL" >&2
    exit 1
  fi
  echo "  [sd] SHA256 tamam"
else
  echo "  [sd] UYARI: bu varlik icin saglama toplami bildirilmemis." >&2
fi

mkdir -p "$TARGET" "$WORK/x"
# Arsiv ayri bir dizine acilir: sd-server arsivin kokunde durdugu icin
# ayni dizine acmak indirilen zip'i de kurulum dizinine kopyalatirdi.
case "$ASSET_NAME" in
  *.tar.gz) tar -xzf "$WORK/$ASSET_NAME" -C "$WORK/x" ;;
  *.zip)    unzip -q "$WORK/$ASSET_NAME" -d "$WORK/x" ;;
  *) echo "  [sd] bilinmeyen arsiv bicimi: $ASSET_NAME" >&2; exit 1 ;;
esac

# sd-server, libstable-diffusion.dylib'i yaninda arar; duzeni bozmadan tasiriz.
SRC_DIR="$(dirname "$(find "$WORK/x" -name 'sd-server' -type f | head -1)")"
if [[ -z "$SRC_DIR" || ! -d "$SRC_DIR" ]]; then
  echo "  [sd] arsiv icinde sd-server bulunamadi." >&2
  exit 1
fi
cp -R "$SRC_DIR"/. "$TARGET"/
chmod +x "$TARGET"/sd-* 2>/dev/null || true

if [[ ! -x "$TARGET/sd-server" ]]; then
  echo "  [sd] sd-server calistirilabilir degil." >&2
  exit 1
fi
echo "  [sd] hazir: $TARGET/sd-server"
