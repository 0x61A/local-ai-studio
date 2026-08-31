import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AUDIO_MODELS_DIR, RUNTIME_DIR } from "../config.js";

/**
 * whisper.cpp konuşma tanıma.
 *
 * Sunucu değil tek atış: bir kaydı yazıya dökmek zaten tek seferlik bir iş
 * ve modeli sürekli bellekte tutmak (base için ~150 MB) karşılığı olmayan
 * bir maliyet olurdu.
 *
 * İkili dosya sırayla aranır: önce kendi `runtime/` dizinimiz, sonra
 * PATH. PATH'e bakmamızın sebebi macOS: whisper.cpp macOS için hazır ikili
 * yayımlamıyor (Linux ve Windows için yayımlıyor). Referans proje bu boşluğu
 * kurulum sırasında Homebrew ile whisper-cpp kurarak kapatıyor -- yani kendi
 * "sıfır kurulum" vaadini bozuyor. Biz sisteme bir şey kurmayız; kullanıcıda
 * zaten varsa kullanırız, yoksa bulut sağlayıcısına düşeriz.
 */

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Uzun kayıtlarda bile makul bir tavan; asılı kalan süreç bırakmayalım. */
const TRANSCRIBE_TIMEOUT_MS = 30 * 60 * 1000;

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  language: string;
  segments: WhisperSegment[];
  ms: number;
}

export function whisperBinary(): string | null {
  const bundled = path.join(RUNTIME_DIR, "engines", "whisper", "whisper-cli");
  if (isExecutable(bundled)) return bundled;
  return findOnPath("whisper-cli");
}

export function listSpeechModels(): Array<{ filename: string; sizeBytes: number }> {
  if (!fs.existsSync(AUDIO_MODELS_DIR)) return [];
  return fs
    .readdirSync(AUDIO_MODELS_DIR)
    .filter((name) => name.endsWith(".bin"))
    .map((filename) => ({
      filename,
      sizeBytes: safeSize(path.join(AUDIO_MODELS_DIR, filename)),
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename, "tr"));
}

export interface TranscribeOptions {
  /** "auto" dil tespiti yapar. */
  language?: string;
  /** Kaynağı İngilizceye çevir. */
  translate?: boolean;
  threads?: number;
}

/**
 * 16 kHz mono WAV bekler. Dönüştürmeyi tarayıcı yapar (`decodeAudioData`):
 * ffmpeg bağımlılığı eklemek sıfır-kurulum vaadini bozardı ve tarayıcı
 * zaten her formatı çözebiliyor.
 */
export async function transcribe(
  wavPath: string,
  modelFilename: string,
  options: TranscribeOptions = {},
): Promise<TranscriptResult> {
  const binary = whisperBinary();
  if (!binary) {
    throw new Error(
      "whisper.cpp kurulu değil. `bash scripts/setup/fetch-whisper.sh` çalıştırın " +
        "ya da Ayarlar'dan bir bulut sağlayıcısı seçin.",
    );
  }
  const modelPath = path.join(AUDIO_MODELS_DIR, path.basename(modelFilename));
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Konuşma modeli bulunamadı: ${path.basename(modelFilename)}`);
  }

  // Çıktı JSON olarak ses dosyasının yanına yazılır; whisper-cli uzantıyı
  // kendisi ekler.
  const outputBase = `${wavPath}.out`;
  const started = Date.now();

  await run(binary, buildWhisperArgs(modelPath, wavPath, outputBase, options));

  const jsonPath = `${outputBase}.json`;
  try {
    const parsed = parseWhisperJson(fs.readFileSync(jsonPath, "utf8"));
    return { ...parsed, ms: Date.now() - started };
  } finally {
    fs.rmSync(jsonPath, { force: true });
  }
}

export function buildWhisperArgs(
  modelPath: string,
  wavPath: string,
  outputBase: string,
  options: TranscribeOptions = {},
): string[] {
  const args = [
    "--model", modelPath,
    "--file", wavPath,
    "--output-json",
    "--output-file", outputBase,
    // Metin ve ilerleme stdout'a basılmasın; sonucu JSON'dan okuyoruz.
    "--no-prints",
    "--language", options.language && options.language !== "auto" ? options.language : "auto",
  ];
  if (options.translate) args.push("--translate");
  if (options.threads && options.threads > 0) {
    args.push("--threads", String(options.threads));
  }
  return args;
}

/**
 * whisper-cli JSON'u sürümler arasında biraz değişiyor; zaman damgaları
 * kimi sürümde milisaniye kimi sürümde "00:00:01,200" metni. İkisini de
 * kabul ederiz, çözemezsek segment yine de metnini verir.
 */
export function parseWhisperJson(raw: string): Omit<TranscriptResult, "ms"> {
  const payload = JSON.parse(raw) as {
    result?: { language?: string };
    transcription?: Array<{
      text?: string;
      offsets?: { from?: number; to?: number };
      timestamps?: { from?: string; to?: string };
    }>;
  };

  const segments: WhisperSegment[] = (payload.transcription ?? []).map((entry) => ({
    start: entry.offsets?.from !== undefined
      ? entry.offsets.from / 1000
      : parseTimestamp(entry.timestamps?.from),
    end: entry.offsets?.to !== undefined
      ? entry.offsets.to / 1000
      : parseTimestamp(entry.timestamps?.to),
    text: (entry.text ?? "").trim(),
  }));

  return {
    text: segments.map((segment) => segment.text).join(" ").replace(/\s+/g, " ").trim(),
    language: payload.result?.language ?? "",
    segments: segments.filter((segment) => segment.text),
  };
}

function parseTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const match = /^(\d+):(\d+):(\d+)[.,](\d+)$/.exec(value.trim());
  if (!match) return 0;
  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(`0.${fraction}`)
  );
}

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: TRANSCRIBE_TIMEOUT_MS },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message).trim().split("\n").slice(-3).join(" ");
          reject(new Error(`whisper.cpp başarısız: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function findOnPath(command: string): string | null {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function safeSize(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}
