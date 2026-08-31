# Local AI Studio

Sifir kurulum gerektiren, tamamen yerel calisan yapay zeka calisma alani.
Node.js + TypeScript tek calisma zamani; agir hesap native motorlarda
(llama.cpp, stable-diffusion.cpp, whisper.cpp).

## Durum

| Faz | Kapsam | Durum |
| --- | --- | --- |
| 0 | Iskelet, guvenli HTTP katmani, donanim tespiti, i18n, testler | tamamlandi |
| 1 | Motor supervisor, model yoneticisi, saglayici katmani, sohbet | tamamlandi |
| 2 | Tool-calling ajan, onay kapisi, MCP istemcisi | tamamlandi |
| 3 | RAG / bilgi tabani (PDF, DOCX, Markdown, kod) | tamamlandi |
| 4 | Gorsel uretimi + ses (STT/TTS) | siradaki |
| 5 | Cok-ajanli planlayici, bilgisayar kullanimi | planlandi |
| 6 | Windows + Linux | planlandi |

## Calistirma

```bash
./start.command
```

Ilk calistirmada tasinabilir Node.js `runtime/node` altina indirilir
(SHA256 dogrulamali). Sisteme hicbir sey kurulmaz.

Yerel model calistirmak icin llama.cpp motoru da gerekir:

```bash
bash scripts/setup/fetch-llama.sh
```

Sonra arayuzdeki **Modeller** sekmesinden Hugging Face'te arama yapip tek
tikla model indirebilirsiniz. Bulut saglayicilari (OpenAI, Anthropic,
Gemini, OpenRouter) icin **Ayarlar** sekmesinden API anahtari ekleyin.

## Neler var

- **Sohbet**: yerel GGUF modeller ve bulut saglayicilari ayni arayuzde,
  akisli yanit, konusma gecmisi, tam metin arama
- **Modeller**: Hugging Face arama, donanima gore nicemleme onerisi,
  kaldigi yerden devam eden ve SHA256 dogrulanan indirme, motor kontrolu
- **Ajan**: arac cagiran ajan dongusu. Dosya oku/yaz/sil, klasor listele,
  metin ara, web arama, sayfa cekme, komut calistirma. Yazma ve komut
  islemleri onay kartinda fark onizlemesiyle onay ister.
- **MCP**: Model Context Protocol sunuculari takilabilir; araclari ajana
  eklenir. Sunucu salt okunur oldugunu bildirmezse araclari onay ister.
- **Bilgi tabani (RAG)**: PDF, DOCX, Markdown, duz metin ve kod dosyalari
  yuklenir; baslik ve sayfa farkindalikli parcalanir, gomme vektorleri
  uretilir. Arama anlamsal benzerlik ile tam metin (FTS5) sonuclarini sira
  tabanli birlestirir -- yalnizca anlamsal arama surum numarasi, urun kodu
  gibi birebir terimleri kacirir. Cevaplar `[1]`, `[2]` seklinde kaynak
  numarasi tasir; kaynak paneli belge adini, sayfayi ve eslesen metni
  gosterir. Ajan da `knowledge_search` araciyla ayni tabana bakar.
- **Gomme motoru**: sohbet modelinden ayri bir llama.cpp yuvasi. Ikisi de
  bellek butcesine sigdigi surece ayni anda yuklu kalir; bulut gomme
  (OpenAI, Gemini) secilirse yerel motor hic gerekmez.
- **Ayarlar**: API anahtarlari (sifreli saklanir), web arama saglayicilari,
  MCP sunuculari, sistem istemi, sicaklik, belirtec siniri
- **Sistem**: donanim bilgisi ve canli kullanim

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
- **API anahtarlari** AES-256-GCM ile sifrelenir; ana anahtar macOS
  Anahtar Zinciri'nde tutulur. Anahtarin kendisi hicbir zaman komut satiri
  argumani olmaz (`ps` ciktisina sizardi) ve istemciye yalnizca maskesi
  doner.
- **Model indirmeleri** konak beyaz listesinden gecer ve Hugging Face'in
  bildirdigi SHA256 ile dogrulanir.
- **Ajan sandbox'i**: tum dosya araclari secilen calisma alani klasorune
  kilitlidir; sembolik bag dahil disari cikan istek hata doner. Ev dizini
  gibi genis klasorler calisma alani olarak kabul edilmez.
- **Onay kapisi**: yazma ve komut calistirma her seferinde onay ister.
  Varsayilan reddetmektir -- zaman asimi, sekme kapanmasi veya sunucu
  yeniden baslamasi izin anlamina gelmez.
- **Web'den cekilen icerik** modele "guvenilmez dis icerik" olarak
  etiketlenerek verilir.
- **Motor surecleri** sunucu kapaninca durdurulur; cokme sonrasi kalan
  yetimler acilista toplanir (yalnizca kendi ikili dosyamizi calistiran
  surecler, kimlik `ps` ciktisiyla dogrulanarak).

- **Belge yukleme** yalnizca tarayicidan secilen dosyayla yapilir; sunucuya
  "su yoldaki dosyayi indeksle" dedirtilemez. Boyle bir uc, yerel istekler
  icin keyfi dosya okuma yetkisi olurdu.

Bu dort madde `packages/server/test/server.test.ts` icinde test edilir.

## Lisans

MIT
