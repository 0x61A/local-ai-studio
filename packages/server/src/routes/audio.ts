import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AUDIO_MODELS_DIR, AUDIO_OUTPUTS_DIR } from "../config.js";
import { listSpeechModels, whisperBinary } from "../engines/whisper.js";
import { transcribeWav } from "../audio/transcribe.js";
import { listVoices, speak, ttsAvailable } from "../audio/tts.js";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import { hasSecret } from "../security/secrets.js";
import { resolveInside } from "../security/paths.js";

/**
 * Ses uçları.
 *
 * Yazıya dökme 16 kHz mono WAV bekler; dönüştürmeyi tarayıcı yapar
 * (`AudioContext.decodeAudioData`). Sunucuya ffmpeg koymamanın karşılığı
 * bu: tarayıcı zaten mp3, m4a, ogg, webm hepsini çözebiliyor.
 */

/** 16 kHz mono 16-bit'te ~26 dakika. */
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

const TranscribeBody = z.object({
  /** WAV içeriği base64. */
  audio: z.string().min(1),
  provider: z.enum(["local", "openai"]).optional(),
  model: z.string().max(255).optional(),
  language: z.string().max(10).optional(),
  translate: z.boolean().optional(),
});

const SpeakBody = z.object({
  text: z.string().min(1).max(20_000),
  voice: z.string().max(120).optional(),
  rate: z.number().int().min(80).max(500).optional(),
});

export function registerAudioRoutes(router: Router): void {
  router.get("/api/audio", {}, async () => ({
    speech: {
      binary: whisperBinary(),
      models: listSpeechModels(),
      modelsDir: AUDIO_MODELS_DIR,
      cloudAvailable: hasSecret("openai"),
    },
    tts: {
      available: ttsAvailable(),
      voices: await listVoices(),
    },
    outputs: listAudioOutputs(),
    maxAudioBytes: MAX_AUDIO_BYTES,
  }));

  router.post("/api/audio/transcribe", { body: TranscribeBody }, async ({ body }) => {
    const wav = decodeAudio(body.audio);
    const provider = body.provider ?? "local";
    if (provider === "local" && !body.model) {
      throw HttpError.badRequest("no_model", "Bir konuşma modeli seçin.");
    }
    try {
      return {
        transcript: await transcribeWav(wav, {
          provider,
          model: body.model ?? "whisper-1",
          ...(body.language ? { language: body.language } : {}),
          ...(body.translate ? { translate: true } : {}),
        }),
      };
    } catch (err) {
      throw HttpError.badRequest("transcribe_failed", (err as Error).message);
    }
  });

  router.post("/api/audio/speak", { body: SpeakBody }, async ({ body }) => {
    try {
      return {
        speech: await speak(body.text, body.voice, body.rate),
        outputs: listAudioOutputs(),
      };
    } catch (err) {
      throw HttpError.badRequest("speak_failed", (err as Error).message);
    }
  });

  router.get("/api/audio/outputs", {}, () => ({ outputs: listAudioOutputs() }));

  router.del("/api/audio/outputs/:filename", {}, async ({ params }) => {
    const file = resolveInside(AUDIO_OUTPUTS_DIR, params["filename"] as string);
    await fsp.rm(file, { force: true });
    return { outputs: listAudioOutputs() };
  });

  /** Ses dosyası. Görsellerde olduğu gibi istemci `fetch` ile çeker. */
  router.get("/api/audio/file/:filename", {}, ({ params, res }) => {
    const file = resolveInside(AUDIO_OUTPUTS_DIR, params["filename"] as string);
    if (!fs.existsSync(file)) throw HttpError.notFound("Ses dosyası bulunamadı.");
    const bytes = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": "audio/wav",
      "content-length": bytes.length,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(bytes);
    return undefined;
  });
}

export interface AudioOutput {
  filename: string;
  sizeBytes: number;
  createdAt: number;
}

function listAudioOutputs(): AudioOutput[] {
  if (!fs.existsSync(AUDIO_OUTPUTS_DIR)) return [];
  return fs
    .readdirSync(AUDIO_OUTPUTS_DIR)
    .filter((name) => name.endsWith(".wav"))
    .map((filename) => {
      const stats = fs.statSync(path.join(AUDIO_OUTPUTS_DIR, filename));
      return { filename, sizeBytes: stats.size, createdAt: stats.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 200);
}

function decodeAudio(content: string): Buffer {
  if ((content.length / 4) * 3 > MAX_AUDIO_BYTES) {
    throw HttpError.badRequest(
      "audio_too_large",
      `Ses dosyası çok büyük. En fazla ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB.`,
    );
  }
  const bytes = Buffer.from(content, "base64");
  if (!bytes.byteLength) {
    throw HttpError.badRequest("empty_audio", "Ses verisi boş ya da base64 çözülemedi.");
  }
  return bytes;
}
