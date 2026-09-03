#!/usr/bin/env bash
# Local AI Studio - macOS ve Linux baslatici. Cift tiklayin ya da calistirin.
# (Linux'ta ayni dosya start-linux.sh adiyla da duruyor; Windows: start.bat)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

NODE_BIN="$ROOT/runtime/node/bin/node"
SERVER_JS="$ROOT/packages/server/dist/server.cjs"
WEB_INDEX="$ROOT/packages/web/dist/index.html"

# 1) Tasinabilir Node -- yoksa indir. Sistem Node'una dokunmayiz.
if [[ ! -x "$NODE_BIN" ]]; then
  echo "  Ilk calistirma: tasinabilir Node.js kuruluyor..."
  bash "$ROOT/scripts/setup/fetch-node.sh"
fi

# 2) Derlenmis cikti yoksa (kaynak kopyasi) burada uret.
#    Bagimliliklar da eksikse tasinabilir npm ile kurulur: depoyu klonlayan
#    kullanicidan once sisteme Node kurmasini istemek "sifir kurulum"
#    vaadini bozardi. Yayin paketinde dist/ hazir gelir, bu blok hic calismaz.
if [[ ! -f "$SERVER_JS" || ! -f "$WEB_INDEX" ]]; then
  export PATH="$ROOT/runtime/node/bin:$PATH"
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "  Ilk calistirma: bagimliliklar kuruluyor (birkac dakika surebilir)..."
    # package-lock.json varsa ci daha hizli ve kilitle birebir ayni.
    if [[ -f "$ROOT/package-lock.json" ]]; then
      npm ci --no-audit --no-fund --loglevel=error
    else
      npm install --no-audit --no-fund --loglevel=error
    fi
  fi
  echo "  Derlenmis cikti eksik, build calistiriliyor..."
  npm run build
fi

export STUDIO_ROOT="$ROOT"

# Tarayiciyi acan komut platforma gore degisir; ikisi de yoksa URL'yi basariz.
case "$(uname -s)" in
  Darwin) OPENER="open" ;;
  *)      OPENER="xdg-open" ;;
esac

# 3) Sunucuyu baslat, STUDIO_URL satirini yakalayip tarayiciyi ac.
#    Yalnizca kendi baslattigimiz PID'i yonetiriz -- baska surec oldurmeyiz.
LOG_PIPE="$(mktemp -u "${TMPDIR:-/tmp}/studio.XXXXXX")"
mkfifo "$LOG_PIPE"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.5
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$LOG_PIPE"
}
trap cleanup EXIT INT TERM

"$NODE_BIN" "$SERVER_JS" > "$LOG_PIPE" 2>&1 &
SERVER_PID=$!

opened=0
while IFS= read -r line; do
  case "$line" in
    STUDIO_URL=*)
      if [[ "$opened" -eq 0 ]]; then
        opened=1
        url="${line#STUDIO_URL=}"
        if command -v "$OPENER" >/dev/null 2>&1; then
          "$OPENER" "$url" >/dev/null 2>&1 || true
        else
          printf 'Tarayicida acin: %s\n' "$url"
        fi
      fi
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$LOG_PIPE"

wait "$SERVER_PID" 2>/dev/null || true
