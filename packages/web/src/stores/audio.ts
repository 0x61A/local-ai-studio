import { create } from "zustand";
import { api, type AudioOverview, type Transcript } from "../lib/api";
import { toBase64, toWav16k } from "../lib/audio";

/** Ses sekmesi durumu: yazıya dökme, seslendirme, çıktı listesi. */

interface AudioState {
  overview: AudioOverview | null;
  transcript: Transcript | null;
  transcribing: boolean;
  speaking: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  transcribeBlob: (
    blob: Blob,
    options: { provider: "local" | "openai"; model: string; language: string; translate: boolean },
  ) => Promise<void>;
  speak: (text: string, voice: string, rate: number) => Promise<void>;
  removeOutput: (filename: string) => Promise<void>;
  clearError: () => void;
  clearTranscript: () => void;
}

export const useAudio = create<AudioState>((set, get) => ({
  overview: null,
  transcript: null,
  transcribing: false,
  speaking: false,
  error: null,

  clearError: () => set({ error: null }),
  clearTranscript: () => set({ transcript: null }),

  refresh: async () => {
    try {
      set({ overview: await api.audio(), error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  transcribeBlob: async (blob, options) => {
    set({ transcribing: true, error: null, transcript: null });
    try {
      // Dönüştürme tarayıcıda: sunucu 16 kHz mono WAV bekliyor.
      const wav = await toWav16k(blob);
      const limit = get().overview?.maxAudioBytes ?? 0;
      if (limit && wav.byteLength > limit) {
        throw new Error(
          `Kayıt çok uzun (${Math.round(wav.byteLength / 1048576)} MB). ` +
            `En fazla ${Math.round(limit / 1048576)} MB.`,
        );
      }
      const { transcript } = await api.transcribe({
        audio: toBase64(wav),
        provider: options.provider,
        ...(options.provider === "local" ? { model: options.model } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.translate ? { translate: true } : {}),
      });
      set({ transcript });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ transcribing: false });
    }
  },

  speak: async (text, voice, rate) => {
    set({ speaking: true, error: null });
    try {
      const { outputs } = await api.speak(text, voice || undefined, rate || undefined);
      set((state) =>
        state.overview ? { overview: { ...state.overview, outputs } } : state,
      );
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ speaking: false });
    }
  },

  removeOutput: async (filename) => {
    const { outputs } = await api.deleteAudioOutput(filename);
    set((state) => (state.overview ? { overview: { ...state.overview, outputs } } : state));
  },
}));
