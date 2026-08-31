import { create } from "zustand";
import {
  api,
  type DownloadTask,
  type EngineInfo,
  type LocalModel,
  type ProviderInfo,
  type ProviderModel,
} from "../lib/api";

interface ModelsState {
  local: LocalModel[];
  engine: EngineInfo | null;
  downloads: DownloadTask[];
  providers: ProviderInfo[];
  /** Sağlayıcı kimliği -> model listesi. */
  providerModels: Record<string, ProviderModel[]>;
  providerModelError: Record<string, string>;
  busy: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  refreshDownloads: () => Promise<void>;
  loadProviderModels: (id: string) => Promise<void>;
  loadEngine: (filename: string) => Promise<void>;
  unloadEngine: () => Promise<void>;
  deleteModel: (filename: string) => Promise<void>;
  download: (url: string, filename: string, sha256: string | null) => Promise<void>;
  cancelDownload: (id: string) => Promise<void>;
}

export const useModels = create<ModelsState>((set, get) => ({
  local: [],
  engine: null,
  downloads: [],
  providers: [],
  providerModels: {},
  providerModelError: {},
  busy: false,
  error: null,

  refresh: async () => {
    try {
      const [models, engine, providers] = await Promise.all([
        api.models(),
        api.engine(),
        api.providers(),
      ]);
      set({ local: models.models, engine, providers, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  refreshDownloads: async () => {
    try {
      set({ downloads: await api.downloads() });
    } catch {
      // Yoklama hatası sessiz: bir sonraki turda düzelir.
    }
  },

  loadProviderModels: async (id) => {
    try {
      const result = await api.providerModels(id);
      set((state) => ({
        providerModels: { ...state.providerModels, [id]: result.models },
        providerModelError: {
          ...state.providerModelError,
          [id]: result.error ?? "",
        },
      }));
    } catch (err) {
      set((state) => ({
        providerModelError: {
          ...state.providerModelError,
          [id]: (err as Error).message,
        },
      }));
    }
  },

  loadEngine: async (filename) => {
    set({ busy: true, error: null });
    try {
      set({ engine: await api.loadEngine(filename) });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
      void get().refresh();
    }
  },

  unloadEngine: async () => {
    set({ busy: true });
    try {
      set({ engine: await api.unloadEngine() });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
      void get().refresh();
    }
  },

  deleteModel: async (filename) => {
    try {
      await api.deleteModel(filename);
      await get().refresh();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  download: async (url, filename, sha256) => {
    try {
      await api.startDownload(url, filename, sha256);
      await get().refreshDownloads();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  cancelDownload: async (id) => {
    await api.cancelDownload(id);
    await get().refreshDownloads();
  },
}));
