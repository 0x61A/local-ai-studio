# Local AI Studio

Sifir kurulum gerektiren, tamamen yerel calisan yapay zeka calisma alani.
Node.js + TypeScript tek calisma zamani; agir hesap native motorlarda
(llama.cpp, stable-diffusion.cpp, whisper.cpp).

## Durum

| Faz | Kapsam | Durum |
| --- | --- | --- |
| 0 | Iskelet, guvenli HTTP katmani, donanim tespiti, i18n, testler | tamamlandi |
| 1 | Motor supervisor, model yoneticisi, saglayici katmani, sohbet | siradaki |
| 2 | Tool-calling ajan, onay kapisi, MCP istemcisi | planlandi |
| 3 | RAG / bilgi tabani | planlandi |
| 4 | Gorsel uretimi + ses (STT/TTS) | planlandi |
| 5 | Cok-ajanli planlayici, bilgisayar kullanimi | planlandi |
| 6 | Windows + Linux | planlandi |

## Calistirma

```bash
./start.command
```

Ilk calistirmada tasinabilir Node.js `runtime/node` altina indirilir
(SHA256 dogrulamali). Sisteme hicbir sey kurulmaz.

## Gelistirme

```bash
npm install
npm run build       # server -> packages/server/dist/server.cjs, web -> packages/web/dist
npm test            # vitest
npm run typecheck   # tsc
```

Canli gelistirme icin iki terminal:

```bash
npm run dev:server  # esbuild izleme modu (ayrica: node packages/server/dist/server.cjs)
npm run dev:web     # vite dev sunucusu, /api isteklerini sunucuya proxy'ler
```

## Guvenlik modeli

- Sunucu **yalnizca `127.0.0.1`** dinler. Ag uzerinden erisilemez.
- Her baslangicta rastgele **oturum token'i** uretilir; diske yazilmaz.
  Launcher tarayiciyi `#t=<token>` fragment'i ile acar -- fragment sunucuya
  gonderilmez, tarayicida `sessionStorage`'a alinip adres cubugundan silinir.
- **CORS basligi gonderilmez.** `Origin`, `Sec-Fetch-Site` ve `Host` basliklari
  dogrulanir; capraz-site istekleri ve DNS rebinding reddedilir.
- Dosyaya dokunan her yol `resolveInside()` uzerinden gecer; sembolik bag
  dahil kok disina cikan istek 403 doner.

Bu dort madde `packages/server/test/server.test.ts` icinde test edilir.

## Lisans

MIT
