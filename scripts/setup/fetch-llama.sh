#!/usr/bin/env bash
# llama.cpp motorunu runtime/engines/llama altina indirir.
# Indirilen arsiv GitHub'in bildirdigi SHA256 ile dogrulanir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT/runtime/engines/llama"
REPO="ggml-org/llama.cpp"

if [[ -x "$TARGET/llama-server" ]]; then
  echo "  [llama] zaten kurulu: $("$TARGET/llama-server" --version 2>&1 | head -1)"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PATTERN="bin-macos-arm64" ;;
  Darwin-x86_64) PATTERN="bin-macos-x64" ;;
  Linux-x86_64)  PATTERN="bin-ubuntu-x64" ;;
  *) echo "  [llama] bu platform icin hazir ikili yok: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "  [llama] son surum araniyor ($PATTERN)..."
# /releases/latest llama.cpp'de build etiketini vermiyor; listeyi tarariz.
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
  echo "  [llama] uygun varlik bulunamadi." >&2
  exit 1
fi

echo "  [llama] indiriliyor: $ASSET_NAME"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fL --progress-bar -o "$WORK/$ASSET_NAME" "$ASSET_URL"

if [[ -n "${ASSET_DIGEST:-}" ]]; then
  echo "  [llama] SHA256 dogrulaniyor..."
  ACTUAL="$(shasum -a 256 "$WORK/$ASSET_NAME" | awk '{print $1}')"
  if [[ "$ACTUAL" != "$ASSET_DIGEST" ]]; then
    echo "  [llama] SHA256 UYUSMUYOR. Beklenen $ASSET_DIGEST, bulunan $ACTUAL" >&2
    exit 1
  fi
  echo "  [llama] SHA256 tamam"
else
  echo "  [llama] UYARI: bu varlik icin saglama toplami bildirilmemis." >&2
fi

mkdir -p "$TARGET"
case "$ASSET_NAME" in
  *.tar.gz) tar -xzf "$WORK/$ASSET_NAME" -C "$WORK" ;;
  *.zip)    unzip -q "$WORK/$ASSET_NAME" -d "$WORK" ;;
  *) echo "  [llama] bilinmeyen arsiv bicimi: $ASSET_NAME" >&2; exit 1 ;;
esac

# Arsivde ikililer ve kutuphaneler ayni dizinde; rpath @loader_path oldugu
# icin duzen korunmali. Ayrica libggml.0.dylib gibi adlar sembolik bag --
# dosya dosya kopyalamak onlari atlar ve dyld cokerdi. Dizini oldugu gibi
# tasiriz.
SRC_DIR="$(find "$WORK" -type d -name 'llama-*' -maxdepth 2 | head -1)"
if [[ -z "$SRC_DIR" ]]; then
  # Bazi surumler bin/ ve lib/ ayrimi kullaniyor.
  SRC_DIR="$(dirname "$(find "$WORK" -name 'llama-server' -type f | head -1)")"
fi
if [[ -z "$SRC_DIR" || ! -d "$SRC_DIR" ]]; then
  echo "  [llama] arsiv icinde ikili dizini bulunamadi." >&2
  exit 1
fi

# -R sembolik baglari bag olarak korur.
cp -R "$SRC_DIR"/. "$TARGET"/
chmod +x "$TARGET"/llama-* 2>/dev/null || true

# bin/ + lib/ duzeni varsa kutuphaneleri ikililerin yanina getir.
if [[ -d "$TARGET/bin" ]]; then
  cp -R "$TARGET/bin"/. "$TARGET"/ && rm -rf "$TARGET/bin"
fi
if [[ -d "$TARGET/lib" ]]; then
  cp -R "$TARGET/lib"/. "$TARGET"/ && rm -rf "$TARGET/lib"
fi

if [[ ! -x "$TARGET/llama-server" ]]; then
  echo "  [llama] llama-server arsivde bulunamadi." >&2
  exit 1
fi
echo "  [llama] hazir: $("$TARGET/llama-server" --version 2>&1 | head -1)"
