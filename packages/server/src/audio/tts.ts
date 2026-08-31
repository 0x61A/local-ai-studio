import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUDIO_OUTPUTS_DIR } from "../config.js";

/**
 * Metinden konuşma.
 *
 * macOS'un yerleşik `say` komutu kullanılır: 180'den fazla ses, Türkçe
 * dahil, indirilecek model yok, sıfır kurulum. Referans proje bunun için
 * `kokoro-js` + `onnxruntime-node` taşıyor -- native npm modülü, yani
 * platform × mimari başına prebuild derdi; tam olarak kaçındığımız şey.
 *
 * Windows ve Linux Faz 6'da: orada llama.cpp'nin `llama-tts` ikilisi zaten
 * pakette geliyor, ayrıca bağımlılık gerekmiyor.
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

export function ttsAvailable(): boolean {
  return process.platform === "darwin";
}

let voiceCache: Voice[] | null = null;

export async function listVoices(): Promise<Voice[]> {
  if (!ttsAvailable()) return [];
  if (voiceCache) return voiceCache;
  const output = await run("say", ["-v", "?"]).catch(() => "");
  voiceCache = parseVoices(output);
  return voiceCache;
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
  if (!ttsAvailable()) {
    throw new Error(
      "Metinden sese şu an yalnızca macOS'ta çalışıyor. Windows ve Linux Faz 6'da gelecek.",
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
    await run("say", buildSayArgs(textPath, outputPath, voice, rate));
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

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: SAY_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
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

/** Testler için: ses listesi önbelleğini boşaltır. */
export function resetVoiceCache(): void {
  voiceCache = null;
}
