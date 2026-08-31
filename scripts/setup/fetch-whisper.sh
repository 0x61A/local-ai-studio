#!/usr/bin/env bash
# whisper.cpp konusma tanima ikilisini runtime/engines/whisper altina indirir.
#
# NOT: whisper.cpp macOS icin hazir ikili yayimlamiyor (Linux ve Windows icin
# yayimliyor). Bu betik macOS'ta sisteme HICBIR SEY KURMAZ; PATH'te hazir bir
# whisper-cli varsa onu kullanacagimizi soyler, yoksa secenekleri anlatir.
# Referans proje bu bosluğu kurulum sirasinda Homebrew ile whisper-cpp
# kurarak kapatiyor -- yani kendi "sifir kurulum" vaadini bozuyor.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT/runtime/engines/whisper"
REPO="ggml-org/whisper.cpp"

if [[ -x "$TARGET/whisper-cli" ]]; then
  echo "  [whisper] zaten kurulu: $TARGET/whisper-cli"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PATTERN="whisper-bin-ubuntu-x64.tar.gz" ;;
  Linux-aarch64) PATTERN="whisper-bin-ubuntu-arm64.tar.gz" ;;
  Darwin-*)
    EXISTING="$(command -v whisper-cli || true)"
    if [[ -n "$EXISTING" ]]; then
      echo "  [whisper] macOS icin hazir ikili yayimlanmiyor."
      echo "  [whisper] PATH'te bulundu, uygulama bunu kullanacak: $EXISTING"
      exit 0
    fi
    cat >&2 <<'MSG'
  [whisper] macOS icin hazir ikili yayimlanmiyor ve sisteminize paket kurmayiz.
  [whisper] Uc secenek:
  [whisper]   1) Bulut: Ayarlar'dan OpenAI anahtari ekleyin, yaziya dokme orada calisir.
  [whisper]   2) Kendiniz kurun: `brew install whisper-cpp` -- PATH'te bulunca kullaniriz.
  [whisper]   3) Kaynaktan derleyin ve whisper-cli dosyasini su klasore koyun:
  [whisper]      runtime/engines/whisper/
MSG
    exit 2
    ;;
  *) echo "  [whisper] bu platform icin hazir ikili yok: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "  [whisper] son surum araniyor ($PATTERN)..."
META="$(curl -fsSL --max-time 30 "https://api.github.com/repos/$REPO/releases?per_page=10")"

read -r ASSET_URL ASSET_NAME ASSET_DIGEST <<EOF2
$(printf '%s' "$META" | node -e '
let d = "";
process.stdin.on("data", (c) => (d += c)).on("end", () => {
  const pattern = process.argv[1];
  for (const release of JSON.parse(d)) {
    const asset = (release.assets || []).find((a) => a.name === pattern);
    if (asset) {
      console.log(asset.browser_download_url, asset.name, (asset.digest || "").replace(/^sha256:/, ""));
      return;
    }
  }
  process.exit(3);
});' "$PATTERN")
EOF2

if [[ -z "${ASSET_URL:-}" ]]; then
  echo "  [whisper] uygun varlik bulunamadi." >&2
  exit 1
fi

echo "  [whisper] indiriliyor: $ASSET_NAME"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -fL --progress-bar -o "$WORK/$ASSET_NAME" "$ASSET_URL"

if [[ -n "${ASSET_DIGEST:-}" ]]; then
  echo "  [whisper] SHA256 dogrulaniyor..."
  ACTUAL="$(shasum -a 256 "$WORK/$ASSET_NAME" | awk '{print $1}')"
  if [[ "$ACTUAL" != "$ASSET_DIGEST" ]]; then
    echo "  [whisper] SHA256 UYUSMUYOR. Beklenen $ASSET_DIGEST, bulunan $ACTUAL" >&2
    exit 1
  fi
  echo "  [whisper] SHA256 tamam"
else
  echo "  [whisper] UYARI: bu varlik icin saglama toplami bildirilmemis." >&2
fi

mkdir -p "$TARGET" "$WORK/x"
case "$ASSET_NAME" in
  *.tar.gz) tar -xzf "$WORK/$ASSET_NAME" -C "$WORK/x" ;;
  *.zip)    unzip -q "$WORK/$ASSET_NAME" -d "$WORK/x" ;;
  *) echo "  [whisper] bilinmeyen arsiv bicimi: $ASSET_NAME" >&2; exit 1 ;;
esac

SRC_DIR="$(dirname "$(find "$WORK/x" -name 'whisper-cli' -type f | head -1)")"
if [[ -z "$SRC_DIR" || ! -d "$SRC_DIR" ]]; then
  echo "  [whisper] arsiv icinde whisper-cli bulunamadi." >&2
  exit 1
fi
cp -R "$SRC_DIR"/. "$TARGET"/
chmod +x "$TARGET"/whisper-* 2>/dev/null || true

if [[ ! -x "$TARGET/whisper-cli" ]]; then
  echo "  [whisper] whisper-cli calistirilabilir degil." >&2
  exit 1
fi
echo "  [whisper] hazir: $TARGET/whisper-cli"
