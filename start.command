#!/usr/bin/env bash
# Local AI Studio - macOS baslatici. Cift tiklayin veya ./start.command calistirin.
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

# 2) Derlenmis cikti yoksa (gelistirici kopyasi) burada uret.
if [[ ! -f "$SERVER_JS" || ! -f "$WEB_INDEX" ]]; then
  if [[ -d "$ROOT/node_modules" ]]; then
    echo "  Derlenmis cikti eksik, build calistiriliyor..."
    PATH="$ROOT/runtime/node/bin:$PATH" npm run build
  else
    echo "  [HATA] Derlenmis cikti yok ve bagimliliklar kurulu degil." >&2
    echo "         Gelistirici kopyasindaysaniz: npm install && npm run build" >&2
    exit 1
  fi
fi

export STUDIO_ROOT="$ROOT"

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
        open "${line#STUDIO_URL=}" >/dev/null 2>&1 || true
      fi
      ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "$LOG_PIPE"

wait "$SERVER_PID" 2>/dev/null || true
