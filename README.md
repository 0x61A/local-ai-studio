# Local AI Studio

**Sıfır kurulum gerektiren, tamamen yerel çalışan yapay zekâ çalışma alanı.**
Sohbet, araç çağıran ajan, bilgi tabanı, görsel üretimi, ses ve tarayıcı
otomasyonu — hepsi kendi makinenizde, tek bir çalışma zamanıyla.

Node.js + TypeScript. Python yok, native npm modülü yok. Ağır hesap
llama.cpp, stable-diffusion.cpp ve whisper.cpp'de; sunucunun işi orkestrasyon.

```bash
git clone https://github.com/0x61A/local-ai-studio
cd local-ai-studio && ./start.command
```

Sisteminizde Node.js olması gerekmez. İlk çalıştırmada taşınabilir Node
indirilir (SHA256 doğrulamalı), bağımlılıklar onun npm'iyle kurulur, derleme
yapılır ve tarayıcı açılır. Sisteme hiçbir şey kurulmaz; klasörü silmek
uygulamayı silmek demektir.

<details>
<summary><b>English summary</b></summary>

A zero-install, fully local AI workspace: chat with local GGUF models or
cloud providers, a tool-calling agent with an approval gate and sandbox,
RAG over your own documents, image generation, speech-to-text and
text-to-speech, and real browser automation.

Single runtime (Node.js + TypeScript), no Python, no native npm modules.
The server binds `127.0.0.1` only, issues a fresh session token on every
start, and never sends CORS headers. Runs on macOS, Windows and Linux.

Interface and documentation are Turkish-first; the UI ships with English
translations (`TR` / `EN` toggle in the sidebar).
</details>

---

## Durum

| Faz | Kapsam | Durum |
| --- | --- | --- |
| 0 | İskelet, güvenli HTTP katmanı, donanım tespiti, i18n, testler | ✅ |
| 1 | Motor süpervizörü, model yöneticisi, sağlayıcı katmanı, sohbet | ✅ |
| 2 | Araç çağıran ajan, onay kapısı, MCP istemcisi | ✅ |
| 3 | Bilgi tabanı / RAG (PDF, DOCX, Markdown, kod) | ✅ |
| 4 | Görsel üretimi + ses (STT/TTS) | ✅ |
| 5 | Çok ajanlı planlayıcı, tarayıcı otomasyonu | ✅ |
| 6 | Windows + Linux, üç platformlu CI | ✅ |

417 test · 25.000 satır · 0 bağımlılık açığı

> **Dürüstlük notu:** Windows ve Linux yolları gerçek makinede uçtan uca
> çalıştırılmadı. CI üç platformda test ve derleme koşuyor, platforma özgü
> ayrıştırıcılar gerçek çıktı örneklerine karşı birim testli — ama "model
> yüklendi, cevap üretti" adımı yalnızca macOS'ta atıldı.

---

## Neler var

**Sohbet** — Yerel GGUF modeller ve bulut sağlayıcıları (OpenAI, Anthropic,
Gemini, OpenRouter) aynı arayüzde. Akışlı yanıt, konuşma geçmişi, tam metin
arama, görsel gönderme.

**Ajan** — Araç çağıran döngü. Dosya oku/yaz/sil, klasör listele, metin ara,
web araması, sayfa çekme, komut çalıştırma. Yazma ve komut işlemleri onay
kartında fark önizlemesiyle onay ister. **Plan kipi** uzun görevi alt
adımlara böler ve her adımı kendi bağlamıyla ayrı bir alt ajan olarak
çalıştırır.

**MCP** — Model Context Protocol sunucuları takılabilir (stdio + HTTP).
Sunucu salt okunur olduğunu bildirmezse araçları onay ister.

**Bilgi tabanı (RAG)** — PDF, DOCX, Markdown, düz metin ve kod yüklenir;
başlık ve sayfa farkındalıklı parçalanır, gömme vektörleri üretilir. Arama
anlamsal benzerlik ile tam metin (FTS5) sonuçlarını sıra tabanlı birleştirir
— yalnızca anlamsal arama sürüm numarası, ürün kodu gibi birebir terimleri
kaçırır. Cevaplar `[1]`, `[2]` kaynak numarası taşır; kaynak paneli belge
adını, sayfayı ve eşleşen metni gösterir.

**Görsel** — stable-diffusion.cpp ile metinden görsel ve görselden görsel,
yığın üretim, yüksek çözünürlük düzeltmesi, iptal edilebilir iş kuyruğu.
Galeri her görselin üretim parametrelerini tutar — tohum dahil, çünkü tohum
görselin içine gömülü üstveriden okunur ve aynı sonuç yeniden üretilebilir.

**Ses** — Konuşma tanıma (whisper.cpp ya da OpenAI) ve metinden sese. Ses
dönüştürme tarayıcıda yapılır; sunucuda ffmpeg yok.

**Bilgisayar kullanımı** — Gerçek Chromium'da gezinme: sayfa açma, numaralı
öğeye tıklama, forma yazma, ekran görüntüsü. JavaScript ile üretilen sayfalar
ve oturum gerektiren akışlar için. Her eylem onay kapısından geçer.

**Kaynak ve ısınma kontrolü** — Güç profili (performans / dengeli / eko /
özel): çekirdek sayısı, yığın boyutu ve hızlandırıcı kullanımı sınırlanır.

---

## Kurulum

```bash
./start.command          # macOS ve Linux
start.bat                # Windows
```

Motorlar ayrı indirilir; yalnızca kullanacaklarınızı kurun:

```bash
node scripts/setup/fetch-engine.mjs llama     # sohbet (llama.cpp)
node scripts/setup/fetch-engine.mjs sd        # görsel (stable-diffusion.cpp)
node scripts/setup/fetch-engine.mjs whisper   # konuşma tanıma
bash scripts/setup/fetch-playwright.sh        # tarayıcı otomasyonu (isteğe bağlı)
```

Hangi yapının ineceğine donanım karar verir: `nvidia-smi` varsa CUDA,
Linux'ta amdgpu görünüyorsa Vulkan, yoksa CPU. `--variant` ile zorlanabilir.

Sonra arayüzdeki **Modeller** sekmesinden katalogdan tek tıkla model indirin
ya da Hugging Face'te arayın. Bulut sağlayıcıları için **Ayarlar**'dan API
anahtarı ekleyin.

---

## Güvenlik modeli

Bu proje bir referans projenin denetiminden doğdu; oradaki yedi açığın
kapatılması tasarımın çıkış noktası oldu.

| Ne | Nasıl |
| --- | --- |
| Ağ erişimi | Sunucu **yalnızca `127.0.0.1`** dinler |
| Kimlik | Her başlangıçta rastgele oturum token'ı; diske yazılmaz |
| CSRF / rebinding | CORS başlığı **gönderilmez**; `Origin`, `Sec-Fetch-Site`, `Host` doğrulanır |
| Yol güvenliği | Dosyaya dokunan her yol `resolveInside()`'dan geçer; sembolik bağ dahil kök dışı istek 403 |
| API anahtarları | AES-256-GCM; ana anahtar Anahtar Zinciri / DPAPI / 0600 dosyada. Anahtar hiçbir zaman argv'ye girmez, istemciye yalnızca maskesi döner |
| İndirmeler | Konak beyaz listesi + Hugging Face'in bildirdiği SHA256 |
| Ajan sandbox'ı | Dosya araçları seçilen çalışma alanına kilitli; ev dizini gibi geniş klasörler reddedilir |
| Onay kapısı | Yazma, komut ve tarayıcı eylemleri her seferinde sorar. **Varsayılan reddetmek** — zaman aşımı, sekme kapanması ya da sunucu yeniden başlaması izin anlamına gelmez |
| Dış içerik | Web'den ve tarayıcıdan gelen içerik modele "güvenilmez" etiketiyle verilir |
| SSRF | Yönlendirmelerin **her adımı** yeniden doğrulanır; CGNAT ve bulut metadata aralıkları engelli. Tarayıcıda koruma tek adrese değil, sayfanın çıkardığı **her isteğe** uygulanır |
| Parola alanları | Ajan tarayıcıda parola alanına yazamaz; onay verilse bile reddedilir |
| Motor süreçleri | Sunucu kapanınca durdurulur; çökme sonrası yetimler açılışta toplanır — yalnızca kimliği `ps` ile doğrulananlar |

Bu maddelerin çoğu `packages/server/test/` altında testlidir.

---

## Mimari

```
packages/
├── shared/     server ↔ web ortak tipler ve zod şemaları
├── server/
│   ├── http/           router (tablo tabanlı) · auth · güvenli statik · SSE
│   ├── routes/         chat · models · agent · knowledge · images · audio · settings
│   ├── engines/        supervisor + llama · sd · whisper · embedding
│   ├── providers/      tek ChatProvider arayüzü ardında yerel + 4 bulut
│   ├── agent/          loop · planner · approval · sandbox · MCP · tools/
│   ├── browser/        Playwright oturumu (isteğe bağlı yüklenir)
│   ├── rag/            ingest · chunk · embed · search
│   ├── hardware/       donanım tespiti + bellek bütçesi
│   ├── models/         GGUF okuyucu · katalog · indirici · projektör eşleme
│   ├── store/          node:sqlite — konuşma, ayar, sırlar
│   └── security/       yol güvenliği · SSRF · anahtar deposu
└── web/        React + zustand, TR/EN
```

**Bütçe yöneticisi.** Referans projedeki "tek ağır çalışma zamanı" kuralı
yerine ayırma tabanlı slot: her motor ayak izini bildirir, bütçe yeterse
**eş zamanlı yüklü kalır**. Sohbet modeli ve gömme motoru aynı anda çalışır.
Sığmayan model, bölünmek yerine dürüstçe reddedilir.

**GGUF okuyucu.** Katman sayısı, gömme boyutu, GQA başlıkları ve eğitim
bağlamı dosya başlığından okunur; KV önbelleği tahminle değil hesapla bulunur.

### Model kataloğu nasıl güncel kalıyor

Katalogda dosya adı ve indirme adresi tutulmuyor — yalnızca depo kimliği ve
tercih edilen nicemleme. Gerçek dosya adı, boyut, adres ve SHA256 indirmeye
basıldığı anda Hugging Face'in dosya listesinden çözülüyor.

Elle yazılan dosya adları çürür: depo sahipleri dosyaları yeniden adlandırır,
parçalar, siler. Bir noktada 33 girdinin 9'u 404 veriyordu ve bu ancak
kullanıcı indirmeye bastığında görülüyordu. Şimdi kırılabilecek tek şey
deponun kendisi ve o da indirme başlamadan anlaşılır bir hata veriyor.

---

## Geliştirme

```bash
npm install
npm run build       # server → packages/server/dist/server.cjs, web → packages/web/dist
npm test            # vitest
npm run typecheck   # tsc
```

Canlı geliştirme için iki terminal:

```bash
npm run dev:server  # esbuild izleme modu
npm run dev:web     # vite dev sunucusu, /api isteklerini sunucuya proxy'ler
```

### Kendi PyTorch modelinizi çalıştırmak

Mimarisi GPT-2 olan (öğrenilen konum gömme, ön-normalizasyon, birleşik QKV,
4× GELU MLP, bağlı çıkış ağırlığı) bir PyTorch kontrol noktası GGUF'a
çevrilerek diğer modeller gibi çalışır:

```bash
python3 scripts/convert/pt-gpt2-to-gguf.py sft.pt bpe.json data/models/model.gguf
```

Betik bir **geliştirme aracıdır, çalışma zamanı bağımlılığı değil**:
uygulamanın kendisi saf Node.js kalır, çevirme bir kez yapılır. Tokenizer
HuggingFace `tokenizers` biçimindeki `bpe.json`dan okunur ve sohbet şablonu
GGUF'un içine gömülür — model arayüzde ve ajanda özel kod yolu olmadan çalışır.

---

## Platform farkları

Çekirdek her üçünde aynı; farklar işletim sisteminin verdiği şeylerde.

| Konu | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Hızlandırıcı | Metal (birleşik bellek) | CUDA / Vulkan | CUDA / Vulkan |
| VRAM ölçümü | birleşik belleğin %75'i | `nvidia-smi`; diğerinde bilinmiyor | `nvidia-smi` / amdgpu sysfs |
| Seslendirme | `say` | SAPI (System.Speech) | `espeak-ng` |
| Konuşma tanıma | PATH'teki `whisper-cli` | hazır ikili | hazır ikili |
| Ana anahtar | Anahtar Zinciri | DPAPI | 0600 dosya |
| Başlatıcı | `start.command` | `start.bat` | `start-linux.sh` |

VRAM'i ölçemediğimiz kartta katman bölmeyiz: model işlemcide çalışır.
Tahmini bir VRAM sayısına göre katman taşımak sessiz OOM demek olurdu.

---

## Bilinen boşluklar

**Windows ve Linux gerçek makinede denenmedi.** Yukarıdaki dürüstlük notuna
bakın. Bu iki platformda uçtan uca bir tur atacak biri arıyoruz.

**whisper.cpp macOS için hazır ikili yayımlamıyor** (Linux ve Windows için
yayımlıyor). Sisteme paket kurmuyoruz: ikili önce `runtime/`, sonra PATH'te
aranır, bulunamazsa OpenAI ucu devreye girer.

**Tarayıcı otomasyonu isteğe bağlı.** Playwright + Chromium ~150 MB;
kullanıcıların çoğu istemiyor, pakete gömülmez. Kurulu değilken araçlar
listede görünür ama çağrıldıklarında nasıl kurulacağını söyler.

**Alt ajanlar tarayıcı durumunu bilmiyor** — plan kipinde ikinci adım açık
olan sayfayı yeniden açar (zararsız, gereksiz).

---

## Katkı

Hata bildirimi ve pull request'e açığız. Kod Türkçe yorumlanır; değişken ve
fonksiyon adları İngilizce. Yeni davranış için test bekliyoruz — özellikle
güvenlik sınırlarına dokunan değişikliklerde.

## Lisans

MIT — bkz. [LICENSE](LICENSE).
