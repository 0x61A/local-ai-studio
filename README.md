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
| 4 | Gorsel uretimi + ses (STT/TTS) | tamamlandi |
| 5 | Cok-ajanli planlayici, bilgisayar kullanimi | tamamlandi |
| 6 | Windows + Linux, uc platformlu CI | tamamlandi |

## Calistirma

macOS:

```bash
./start.command
```

Linux:

```bash
./start-linux.sh
```

Windows: `start.bat` dosyasina cift tiklayin.

Ilk calistirmada tasinabilir Node.js `runtime/node` altina indirilir
(SHA256 dogrulamali). Sisteme hicbir sey kurulmaz.

Motorlar ayri ayri indirilir; yalnizca kullanacaklarinizi kurun. macOS ve
Linux'ta:

```bash
bash scripts/setup/fetch.sh llama
```

```bash
bash scripts/setup/fetch.sh sd
```

```bash
bash scripts/setup/fetch.sh whisper
```

Tarayici otomasyonu (ajanin gercek bir sayfada gezinmesi) istege bagli:

```bash
bash scripts/setup/fetch.sh browser
```

Windows'ta ayni islerin PowerShell karsiligi:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup\fetch.ps1 llama
```

Hangi yapinin inecegine donanim karar verir: NVIDIA karti varsa CUDA,
AMD/Intel'de Vulkan, hicbiri yoksa CPU yapisi. Zorlamak icin
`--variant cuda|vulkan|cpu` ekleyin. CUDA yapisi Windows'ta calisma zamani
DLL'lerini ayri bir varlikta yolluyor; onu da ayni klasore acariz, yoksa
motor `0xC0000135` ile aciliyor bile.

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
- **Gorsel**: yerel stable-diffusion.cpp ile metinden gorsel ve gorselden
  gorsel (img2img), yigin uretim, yuksek cozunurluk duzeltmesi, iptal
  edilebilir is kuyrugu. Galeri her gorselin yaninda uretim
  parametrelerini tutar -- tohum dahil, cunku tohum gorselin icine gomulu
  ustveriden okunur ve ayni sonucu yeniden uretmek mumkun olur.
- **Ses**: konusma tanima (whisper.cpp ya da OpenAI) ve metinden sese.
  Ses donusturme tarayicida yapilir (`decodeAudioData`), sunucuda ffmpeg
  yok: tarayici zaten mp3, m4a, ogg, webm hepsini cozebiliyor.
- **Plan kipi**: uzun bir gorevi model kendisi alt adimlara boler, her adim
  ayri bir alt ajan olarak kendi baglami ile calisir, sonuclar tek cevapta
  birlestirilir. Kazanc baglam hijyeni: otuz arac cagrisi tek pencereye
  yigilmaz, her adim yalnizca kendi isini ve onceki adimlarin ozetini
  gorur. Adimlar panelde sirayla durum ve sure ile izlenir; is bitince
  panel silinmez.
- **Bilgisayar kullanimi**: gercek Chromium'da gezinme -- sayfa acma,
  numarali ogeye tiklama, forma yazma, ekran goruntusu. `fetch_url` statik
  metin icin; JavaScript ile uretilen sayfalar ve oturum gerektiren akislar
  icin bu. Her eylem onay kapisindan gecer, okuma dahil. Playwright pakete
  gomulmez, `scripts/setup/fetch.sh browser` isteyene kurar.
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
- **API anahtarlari** AES-256-GCM ile sifrelenir; ana anahtar isletim
  sisteminin kendi korumasinda durur: macOS'ta Anahtar Zinciri, Windows'ta
  DPAPI (kullanici hesabina bagli; baska hesap ya da baska makine blob'u
  acamaz), Linux'ta 0600 izinli dosya -- orada dosya izni gercekten
  uygulaniyor, Windows'ta `chmod` NTFS ACL'ine dokunmadigi icin DPAPI
  gerekiyor. Anahtarin kendisi hicbir zaman komut satiri argumani olmaz
  (`ps` ciktisina sizardi) ve istemciye yalnizca maskesi doner.
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
  surecler; kimlik Unix'te `ps`, Windows'ta `tasklist` ciktisiyla
  dogrulanir -- referans projedeki `taskkill /F /IM node.exe` gibi kor bir
  oldurme asla yapilmaz).

- **Belge yukleme** yalnizca tarayicidan secilen dosyayla yapilir; sunucuya
  "su yoldaki dosyayi indeksle" dedirtilemez. Boyle bir uc, yerel istekler
  icin keyfi dosya okuma yetkisi olurdu.
- **Kok disina cikan yol** her ucta 403 doner (500 degil): reddedilmis bir
  istek sunucu hatasi degildir ve deneme gunluge yigilmaz.
- **Seslendirme metni** komut satiri argumani olmaz, gecici dosyadan
  okunur; ses adi gercek ses listesiyle dogrulanir (aksi hâlde `-o` gibi
  bir ad bayrak sanilabilirdi).
- **Tarayici otomasyonunda SSRF korumasi tek adrese degil, sayfanin
  cikardigi HER istege uygulanir.** Adresi kontrol edip gerisini serbest
  birakmak yetmez: sayfa kendi icinden yuzlerce istek yapar ve iclerinden
  biri bulut metadata ucu olabilir. Konak basina bir kez cozumlenir, yoksa
  sayfa kullanilamaz hale gelirdi.
- **Parola alanina yazilmaz.** Onay verilse bile reddedilir: onay kartinda
  gorunecek sey kullanicinin kendi parolasi olurdu ve ajanin elinde dogru
  parola zaten yok.
- **Arac semalarindan dizge uzunluk sinirlari cikarilir.** llama.cpp semayi
  bir GBNF dilbilgisine ceviriyor ve belirli degerler bozuk dilbilgisi
  uretiyor; uzunluk zaten sunucuda zod ile dogrulaniyor.

Bu maddelerin cogu `packages/server/test/server.test.ts` ve
`router.test.ts` icinde test edilir.

### Kendi PyTorch modelinizi calistirmak

Mimarisi GPT-2 olan (ogrenilen konum gomme, on-normalizasyon, birlesik QKV,
4x GELU MLP, bagli cikis agirligi) bir PyTorch kontrol noktasi GGUF'a
cevrilerek diger modeller gibi calisir:

```bash
python3 scripts/convert/pt-gpt2-to-gguf.py sft.pt bpe.json data/models/model.gguf
```

Betik bir **gelistirme aracidir, calisma zamani bagimliligi degil**:
uygulamanin kendisi saf Node.js kalir, cevirme bir kez yapilir. Tokenizer
HuggingFace `tokenizers` bicimindeki `bpe.json`dan okunur ve sohbet sablonu
GGUF'un icine gomulur -- model arayuzde ve ajanda ozel bir kod yolu olmadan
calisir.

Cevirmek yerine modeli TypeScript'te yeniden yazmak da mumkundu; cevirmek
akis, arac cagirma, butce yoneticisi, ajan ve RAG'in tamamini bedava
kazandiriyor.

### Bilinen bosluk: tarayici otomasyonu isteğe bagli

Playwright + Chromium ~150 MB ve kullanicilarin cogu tarayici otomasyonu
istemiyor; pakete gomulmez. `bash scripts/setup/fetch.sh browser`
`runtime/engines/playwright/` altina kurar -- sisteme degil, silmek klasoru
silmek demek. Kurulu degilken tarayici araclari listede gorunur ama
cagrildiklarinda nasil kurulacagini soyler, onay bile istemez.

### Bilinen bosluk: macOS'ta whisper.cpp

whisper.cpp macOS icin hazir ikili yayimlamiyor (Linux ve Windows icin
yayimliyor). Sisteme paket kurmadigimiz icin macOS'ta uc secenek var:
PATH'te hazir bir `whisper-cli` varsa onu kullaniriz, kendiniz kurabilir
ya da bulut saglayicisini secebilirsiniz. `scripts/setup/fetch.sh whisper`
bunu ekranda anlatir. Referans proje ayni bosluğu kurulum sirasinda
Homebrew ile `whisper-cpp` kurarak kapatiyor -- yani kendi sifir kurulum
vaadini boziyor.

### Platform farklari

Cekirdek her ucunde ayni; farklar isletim sisteminin verdigi seylerde:

| Konu | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Hizlandirici | Metal (birlesik bellek) | CUDA / Vulkan | CUDA / Vulkan |
| VRAM olcumu | birlesik bellegin %75'i | `nvidia-smi`; digerinde bilinmiyor | `nvidia-smi` / amdgpu sysfs |
| Seslendirme | `say` | SAPI (System.Speech) | `espeak-ng` (PATH'te varsa) |
| Konusma tanima | PATH'teki `whisper-cli` | hazir ikili | hazir ikili |
| Ana anahtar | Anahtar Zinciri | DPAPI | 0600 dosya |
| Baslatici | `start.command` | `start.bat` | `start-linux.sh` |

VRAM'i olcemedigimiz kartta katman bolmeyiz: model islemcide calisir.
Tahmini bir VRAM sayisina gore katman tasimak sessiz OOM demek olurdu.

## Lisans

MIT
