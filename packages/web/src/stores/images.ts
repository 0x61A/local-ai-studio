import { create } from "zustand";
import {
  api,
  type GenerateImageRequest,
  type ImageJob,
  type ImageOverview,
  type StoredImage,
} from "../lib/api";

/**
 * Görsel üretimi durumu.
 *
 * Üretim uzun sürer (SD 1.5'te 512x512 ~40 sn); ilerleme yoklama ile
 * izlenir ve iş kalmayınca yoklama durur.
 */

const POLL_INTERVAL_MS = 1000;

interface ImageState {
  overview: ImageOverview | null;
  gallery: StoredImage[];
  query: string;
  favoritesOnly: boolean;
  selected: StoredImage | null;
  busy: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  loadGallery: () => Promise<void>;
  setQuery: (query: string) => void;
  setFavoritesOnly: (only: boolean) => void;
  select: (image: StoredImage | null) => void;
  loadEngine: (filename: string) => Promise<void>;
  unloadEngine: () => Promise<void>;
  generate: (input: GenerateImageRequest) => Promise<void>;
  cancelJob: (id: string) => Promise<void>;
  clearJobs: () => Promise<void>;
  toggleFavorite: (image: StoredImage) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearError: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useImages = create<ImageState>((set, get) => {
  const schedulePoll = () => {
    if (pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void get().refresh();
    }, POLL_INTERVAL_MS);
  };

  const running = (jobs: ImageJob[]) =>
    jobs.some(
      (job) => job.state === "queued" || job.state === "generating" || job.state === "saving",
    );

  return {
    overview: null,
    gallery: [],
    query: "",
    favoritesOnly: false,
    selected: null,
    busy: false,
    error: null,

    clearError: () => set({ error: null }),
    select: (image) => set({ selected: image }),

    refresh: async () => {
      try {
        const previous = get().overview?.jobs ?? [];
        const overview = await api.images();
        set({ overview, error: null });
        // Biten iş varsa galeriyi tazele; her turda çekmek gereksiz.
        if (running(previous) && !running(overview.jobs)) await get().loadGallery();
        if (running(overview.jobs)) schedulePoll();
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    loadGallery: async () => {
      try {
        const { query, favoritesOnly } = get();
        const { images } = await api.gallery({
          ...(query.trim() ? { q: query.trim() } : {}),
          favorites: favoritesOnly,
        });
        set({ gallery: images });
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    setQuery: (query) => {
      set({ query });
      void get().loadGallery();
    },

    setFavoritesOnly: (favoritesOnly) => {
      set({ favoritesOnly });
      void get().loadGallery();
    },

    loadEngine: async (filename) => {
      set({ busy: true, error: null });
      try {
        await api.loadImageEngine(filename);
      } catch (err) {
        set({ error: (err as Error).message });
      } finally {
        set({ busy: false });
        await get().refresh();
      }
    },

    unloadEngine: async () => {
      set({ busy: true });
      try {
        await api.unloadImageEngine();
      } finally {
        set({ busy: false });
        await get().refresh();
      }
    },

    generate: async (input) => {
      set({ error: null });
      try {
        await api.generateImage(input);
      } catch (err) {
        set({ error: (err as Error).message });
      }
      await get().refresh();
    },

    cancelJob: async (id) => {
      await api.cancelImageJob(id);
      await get().refresh();
    },

    clearJobs: async () => {
      await api.clearImageJobs();
      await get().refresh();
    },

    toggleFavorite: async (image) => {
      await api.favoriteImage(image.id, !image.favorite);
      await get().loadGallery();
      if (get().selected?.id === image.id) {
        set({ selected: { ...image, favorite: !image.favorite } });
      }
    },

    remove: async (id) => {
      await api.deleteImage(id);
      if (get().selected?.id === id) set({ selected: null });
      await get().loadGallery();
    },
  };
});
