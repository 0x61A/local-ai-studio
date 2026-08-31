import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSecret } from "../security/secrets.js";
import {
  transcribe as transcribeLocal,
  type TranscribeOptions,
  type TranscriptResult,
} from "../engines/whisper.js";

/**
 * Konuşma tanıma.
 *
 * Yerel (whisper.cpp) birinci seçenek. Bulut yolu macOS boşluğu için var:
 * whisper.cpp macOS'a hazır ikili yayımlamıyor ve biz kullanıcının
 * sistemine paket kurmayız. Anahtarı olan kullanıcı yerel ikili olmadan da
 * çalışabilsin diye OpenAI ucu destekleniyor.
 */

export type SpeechProvider = "local" | "openai";

export interface TranscribeRequest {
  provider: SpeechProvider;
  /** Yerelde ggml model dosyası; bulutta model adı. */
  model: string;
  language?: string;
  translate?: boolean;
}

export async function transcribeWav(
  wav: Buffer,
  request: TranscribeRequest,
): Promise<TranscriptResult> {
  if (request.provider === "openai") return transcribeOpenAi(wav, request);

  // whisper.cpp dosya yolu ister; geçici dosya işi bitince silinir.
  const wavPath = path.join(os.tmpdir(), `studio-stt-${crypto.randomUUID()}.wav`);
  await fsp.writeFile(wavPath, wav);
  try {
    const options: TranscribeOptions = {};
    if (request.language) options.language = request.language;
    if (request.translate) options.translate = true;
    return await transcribeLocal(wavPath, request.model, options);
  } finally {
    await fsp.rm(wavPath, { force: true });
  }
}

async function transcribeOpenAi(
  wav: Buffer,
  request: TranscribeRequest,
): Promise<TranscriptResult> {
  const key = getSecret("openai");
  if (!key) {
    throw new Error(
      "OpenAI API anahtarı tanımlı değil. Ayarlar sekmesinden ekleyin ya da yerel whisper.cpp kurun.",
    );
  }

  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
  form.set("model", request.model || "whisper-1");
  form.set("response_format", "verbose_json");
  if (request.language && request.language !== "auto") {
    form.set("language", request.language);
  }
  if (request.translate) form.set("translate", "true");

  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenAI yazıya dökme başarısız (HTTP ${response.status}): ${detail.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    text?: string;
    language?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
  };
  return {
    text: (payload.text ?? "").trim(),
    language: payload.language ?? "",
    segments: (payload.segments ?? []).map((segment) => ({
      start: segment.start ?? 0,
      end: segment.end ?? 0,
      text: (segment.text ?? "").trim(),
    })),
    ms: Date.now() - started,
  };
}
