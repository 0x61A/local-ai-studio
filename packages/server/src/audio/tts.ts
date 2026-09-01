import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUDIO_OUTPUTS_DIR } from "../config.js";
import { findOnPath } from "../engines/supervisor.js";

/**
 * Metinden konuşma.
 *
 * Her platformda işletim sisteminin kendi sentezleyicisi kullanılır:
 * macOS'ta `say`, Windows'ta SAPI (System.Speech), Linux'ta espeak-ng.
 * İlk ikisi kutudan çıkar; Linux'ta yerleşik sentezleyici yok, o yüzden
 * espeak-ng PATH'te varsa kullanılır -- sisteme kurulum yapmayız.
 *
 * Referans proje bunun için `kokoro-js` + `onnxruntime-node` taşıyor --
 * native npm modülü, yani platform × mimari başına prebuild derdi; tam
 * olarak kaçındığımız şey.
 */

const SAY_TIMEOUT_MS = 120_000;
const MAX_TEXT_LENGTH = 20_000;
/** 22 kHz 16-bit LE mono: tarayıcıların tamamı çalar, dosya küçük kalır. */
const DATA_FORMAT = "LEI16@22050";

export interface Voice {
  name: string;
  locale: string;
  sample: string;
}

export interface SpeechResult {
  filename: string;
  bytes: number;
  voice: string;
  ms: number;
}

/** Hangi sentezleyici var? Sonuç süreç ömrü boyunca değişmez. */
export type TtsBackend = "say" | "sapi" | "espeak";

let backendCache: { value: TtsBackend | null } | null = null;

export function ttsBackend(): TtsBackend | null {
  if (backendCache) return backendCache.value;
  const value: TtsBackend | null =
    process.platform === "darwin"
      ? "say"
      : process.platform === "win32"
        ? "sapi"
        : espeakBinary()
          ? "espeak"
          : null;
  backendCache = { value };
  return value;
}

/** espeak-ng yoksa eski `espeak` adı da kabul edilir; ikisi de uyumlu. */
function espeakBinary(): string | null {
  return findOnPath("espeak-ng") ?? findOnPath("espeak");
}

export function ttsAvailable(): boolean {
  return ttsBackend() !== null;
}

let voiceCache: Voice[] | null = null;

export async function listVoices(): Promise<Voice[]> {
  const backend = ttsBackend();
  if (!backend) return [];
  if (voiceCache) return voiceCache;

  if (backend === "say") {
    voiceCache = parseVoices(await run("say", ["-v", "?"]).catch(() => ""));
  } else if (backend === "sapi") {
    voiceCache = parsePipeVoices(
      await run("powershell", powershellArgs(SAPI_LIST_SCRIPT)).catch(() => ""),
    );
  } else {
    const binary = espeakBinary();
    voiceCache = binary
      ? parseEspeakVoices(await run(binary, ["--voices"]).catch(() => ""))
      : [];
  }
  return voiceCache;
}

// -- Windows: SAPI (System.Speech) -------------------------------------------

/**
 * Betik dosyası değil `-Command` kullanıyoruz: Windows'un varsayılan
 * ExecutionPolicy'si `.ps1` dosyalarını çalıştırmaz, oysa `-Command`
 * serbesttir. Kullanıcıdan gelen hiçbir değer betiğe metin olarak
 * gömülmez -- hepsi ortam değişkeniyle geçer, böylece tırnak kaçışı
 * diye bir sorun kalmaz.
 */
const SAPI_LIST_SCRIPT =
  "Add-Type -AssemblyName System.Speech; " +
  "(New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | " +
  "ForEach-Object { $i = $_.VoiceInfo; \"$($i.Name)|$($i.Culture.Name)|$($i.Gender), $($i.Age)\" }";

const SAPI_SPEAK_SCRIPT =
  "Add-Type -AssemblyName System.Speech; " +
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
  "if ($env:STUDIO_TTS_VOICE) { $s.SelectVoice($env:STUDIO_TTS_VOICE) } " +
  "if ($env:STUDIO_TTS_RATE) { $s.Rate = [int]$env:STUDIO_TTS_RATE } " +
  // macOS ile aynı biçim: 22 kHz 16 bit mono, her tarayıcı çalar.
  "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, " +
  "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, " +
  "[System.Speech.AudioFormat.AudioChannel]::Mono); " +
  "$s.SetOutputToWaveFile($env:STUDIO_TTS_OUT, $f); " +
  "$s.Speak([System.IO.File]::ReadAllText($env:STUDIO_TTS_IN)); " +
  "$s.Dispose()";

function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/** `Ad|tr-TR|Female, Adult` satırlarını okur. */
export function parsePipeVoices(output: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split("|");
    if (parts.length < 3) continue;
    const name = (parts[0] ?? "").trim();
    if (!name) continue;
    voices.push({
      name,
      locale: (parts[1] ?? "").trim(),
      sample: (parts[2] ?? "").trim(),
    });
  }
  return voices;
}

/**
 * SAPI hızı -10..10 aralığında bir çarpan; macOS ve espeak dakikadaki
 * kelimeyi ister. Kullanıcı tek bir sayı görüyor, çeviriyi burada yaparız:
 * 175 kelime/dakika nötr kabul edilir.
 */
export function sapiRate(wordsPerMinute: number): number {
  const steps = Math.round((wordsPerMinute - 175) / 17.5);
  return Math.max(-10, Math.min(10, steps));
}

// -- Linux: espeak-ng ---------------------------------------------------------

/**
 * `espeak-ng --voices` sütunları: Pty, Language, Age/Gender, VoiceName, File.
 * Başlık satırı sayıyla başlamadığı için elenir.
 */
export function parseEspeakVoices(output: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*\d+\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line);
    if (!match) continue;
    voices.push({
      name: match[3] as string,
      locale: match[1] as string,
      sample: `${match[2] as string} · ${match[4] as string}`,
    });
  }
  return voices;
}

/** espeak-ng hızı da dakikadaki kelime; macOS ile aynı aralık geçerli. */
export function buildEspeakArgs(
  textPath: string,
  outputPath: string,
  voice: string | null,
  rate?: number,
): string[] {
  const args = ["-w", outputPath, "-f", textPath];
  if (voice) args.push("-v", voice);
  if (rate && rate >= 80 && rate <= 500) args.push("-s", String(Math.round(rate)));
  return args;
}

/**
 * `say -v '?'` satırları: ad, yerel ayar, `#` ve örnek cümle. Ad boşluk ve
 * parantez içerebiliyor ("Flo (Fransızca (Kanada))"), bu yüzden ad
 * yerel ayara kadar isteksiz eşleşir.
 */
export function parseVoices(output: string): Voice[] {
  const voices: Voice[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\s+([a-z]{2,3}(?:[-_][A-Za-z]{2,4})?)\s+#\s*(.*)$/.exec(line.trimEnd());
    if (!match) continue;
    voices.push({
      name: (match[1] as string).trim(),
      locale: match[2] as string,
      sample: (match[3] as string).trim(),
    });
  }
  return voices;
}

export async function speak(
  text: string,
  voiceName: string | undefined,
  rate?: number,
): Promise<SpeechResult> {
  const backend = ttsBackend();
  if (!backend) {
    throw new Error(
      "Metinden sese bu makinede kurulu bir sentezleyici bulunamadı. " +
        "Linux'ta `espeak-ng` kurarsanız kullanılır; ya da Ayarlar'dan bir bulut sağlayıcısı seçin.",
    );
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Seslendirilecek metin boş.");
  if (trimmed.length > MAX_TEXT_LENGTH) {
    throw new Error(`Metin çok uzun (en fazla ${MAX_TEXT_LENGTH} karakter).`);
  }

  // Ses adı doğrudan argümana gitmeden önce gerçek listeyle doğrulanır:
  // "-o" gibi bir ad bayrak sanılabilirdi.
  let voice: string | null = null;
  if (voiceName) {
    const known = (await listVoices()).find((entry) => entry.name === voiceName);
    if (!known) throw new Error(`Bilinmeyen ses: ${voiceName}`);
    voice = known.name;
  }

  await fsp.mkdir(AUDIO_OUTPUTS_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const filename = `${Date.now()}-${id.slice(0, 8)}.wav`;
  const outputPath = path.join(AUDIO_OUTPUTS_DIR, filename);

  // Metin argüman olarak değil dosyadan verilir: uzun metinler argüman
  // sınırını aşar ve argümanlar `ps` çıktısında herkese görünür.
  const textPath = path.join(os.tmpdir(), `studio-tts-${id}.txt`);
  await fsp.writeFile(textPath, trimmed, "utf8");

  const started = Date.now();
  try {
    await synthesize(backend, textPath, outputPath, voice, rate);
  } finally {
    await fsp.rm(textPath, { force: true });
  }

  const stats = await fsp.stat(outputPath);
  return {
    filename,
    bytes: stats.size,
    voice: voice ?? "",
    ms: Date.now() - started,
  };
}

function synthesize(
  backend: TtsBackend,
  textPath: string,
  outputPath: string,
  voice: string | null,
  rate?: number,
): Promise<string> {
  if (backend === "say") {
    return run("say", buildSayArgs(textPath, outputPath, voice, rate));
  }
  if (backend === "espeak") {
    const binary = espeakBinary();
    if (!binary) throw new Error("espeak-ng artık bulunamıyor.");
    return run(binary, buildEspeakArgs(textPath, outputPath, voice, rate));
  }
  return run("powershell", powershellArgs(SAPI_SPEAK_SCRIPT), {
    STUDIO_TTS_IN: textPath,
    STUDIO_TTS_OUT: outputPath,
    ...(voice ? { STUDIO_TTS_VOICE: voice } : {}),
    ...(rate ? { STUDIO_TTS_RATE: String(sapiRate(rate)) } : {}),
  });
}

export function buildSayArgs(
  textPath: string,
  outputPath: string,
  voice: string | null,
  rate?: number,
): string[] {
  const args = ["-f", textPath, "-o", outputPath, "--data-format", DATA_FORMAT];
  if (voice) args.push("-v", voice);
  if (rate && rate >= 80 && rate <= 500) args.push("-r", String(Math.round(rate)));
  return args;
}

function run(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: SAY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message).trim().split("\n").slice(-2).join(" ")));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Testler için: ses listesi ve arka uç önbelleğini boşaltır. */
export function resetVoiceCache(): void {
  voiceCache = null;
  backendCache = null;
}
