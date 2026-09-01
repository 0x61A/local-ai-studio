import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { setupCommand } from "../../config.js";
import { listSpeechModels, whisperBinary } from "../../engines/whisper.js";
import { transcribeWav } from "../../audio/transcribe.js";
import { listVoices, speak, ttsAvailable } from "../../audio/tts.js";
import { PathEscapeError, resolveInside } from "../../security/paths.js";
import { defineTool, type Tool, type ToolResult } from "../types.js";

/**
 * Ses araçları.
 *
 * `transcribe_audio` yalnızca WAV okur: tarayıcıda çalışan dönüştürme
 * (decodeAudioData) ajanın elinde yok ve sunucuya ffmpeg koymak
 * sıfır-kurulum vaadini bozardı. Sınır araç açıklamasında yazılı, model
 * de kullanıcıya aynı şeyi söyleyebilsin diye.
 */

export const transcribeAudio: Tool<{ path: string; language?: string }> = defineTool({
  name: "transcribe_audio",
  description:
    "Çalışma alanındaki bir WAV ses dosyasını yazıya döker (yerel whisper.cpp). " +
    "Yalnızca .wav okur; başka biçimler desteklenmez.",
  risk: "read",
  schema: z.object({
    path: z.string().min(1).describe("Çalışma alanına göre .wav dosya yolu"),
    language: z.string().max(10).optional().describe("Dil kodu ya da 'auto'"),
  }),
  async run(input, context): Promise<ToolResult> {
    if (!whisperBinary()) {
      return {
        content:
          `whisper.cpp kurulu değil; ses yazıya dökülemiyor. Kullanıcının \`${setupCommand("whisper")}\` çalıştırması gerekiyor.`,
        isError: true,
      };
    }
    const model = listSpeechModels()[0];
    if (!model) {
      return { content: "Yüklü konuşma modeli yok.", isError: true };
    }
    if (!input.path.toLowerCase().endsWith(".wav")) {
      return {
        content: `Yalnızca .wav destekleniyor: ${input.path}`,
        isError: true,
      };
    }

    let target: string;
    try {
      target = resolveInside(context.workspaceRoot, input.path);
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return { content: `Yol çalışma alanının dışında: ${input.path}`, isError: true };
      }
      throw err;
    }

    const bytes = await fsp.readFile(target).catch(() => null);
    if (!bytes) return { content: `Dosya bulunamadı: ${input.path}`, isError: true };

    try {
      const result = await transcribeWav(bytes, {
        provider: "local",
        model: model.filename,
        ...(input.language ? { language: input.language } : {}),
      });
      return {
        content: result.text || "(ses dosyasında konuşma bulunamadı)",
        detail: {
          language: result.language,
          segments: result.segments.length,
          ms: result.ms,
          file: path.basename(target),
        },
      };
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  },
});

export const speakText: Tool<{ text: string; voice?: string }> = defineTool({
  name: "speak",
  description:
    "Metni sese çevirir ve ses dosyası olarak kaydeder. Kullanıcı bir şeyin " +
    "seslendirilmesini istediğinde kullan.",
  risk: "write",
  schema: z.object({
    text: z.string().min(1).max(5000).describe("Seslendirilecek metin"),
    voice: z.string().max(120).optional().describe("Ses adı; boşsa sistem varsayılanı"),
  }),
  async run(input, context): Promise<ToolResult> {
    if (!ttsAvailable()) {
      return {
        content: "Metinden sese bu platformda henüz desteklenmiyor.",
        isError: true,
      };
    }

    const approved = await context.requestApproval({
      toolName: "speak",
      risk: "write",
      summary: `Metni seslendir (${input.voice ?? "varsayılan ses"}, ${input.text.length} karakter)`,
      command: input.text.slice(0, 400),
      arguments: { voice: input.voice ?? null },
    });
    if (!approved) return { content: "Kullanıcı seslendirmeyi reddetti.", isError: true };

    try {
      const result = await speak(input.text, input.voice);
      return {
        content: `Ses dosyası oluşturuldu: ${result.filename} (${Math.round(result.bytes / 1024)} KB)`,
        detail: result,
      };
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  },
});

export const listSpeechVoices: Tool<Record<string, never>> = defineTool({
  name: "list_voices",
  description: "Kullanılabilir seslendirme seslerini ve dillerini listeler.",
  risk: "read",
  schema: z.object({}),
  async run(): Promise<ToolResult> {
    const voices = await listVoices();
    if (!voices.length) return { content: "Bu platformda seslendirme sesi yok." };
    return {
      content: voices.map((voice) => `${voice.name} (${voice.locale})`).join("\n"),
      detail: { count: voices.length },
    };
  },
});

export const audioTools = [transcribeAudio, speakText, listSpeechVoices];
