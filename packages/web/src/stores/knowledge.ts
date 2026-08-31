import { create } from "zustand";
import {
  api,
  type IngestJob,
  type KnowledgeDocument,
  type KnowledgeOverview,
  type SourceRef,
} from "../lib/api";
import { readLocal, writeLocal } from "../lib/storage";

/**
 * Bilgi tabanı durumu.
 *
 * İşler sunucuda kuyrukta koştuğu için ilerleme yoklama ile izlenir; iş
 * kalmayınca yoklama durur. Sürekli açık bir akış tutmak tek kullanıcılı
 * yerel uygulamada kazanç değil, sızdırılacak bir kaynak.
 */

const ACTIVE_KEY = "studio.knowledge.collection";
const POLL_INTERVAL_MS = 700;

interface KnowledgeState {
  overview: KnowledgeOverview | null;
  activeId: string | null;
  documents: KnowledgeDocument[];
  sources: SourceRef[];
  searching: boolean;
  uploading: string | null;
  error: string | null;

  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  create: (name: string, provider: string, model: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  upload: (file: File) => Promise<void>;
  removeDocument: (id: string) => Promise<void>;
  testSearch: (query: string) => Promise<void>;
  loadEmbedding: (filename: string) => Promise<void>;
  unloadEmbedding: () => Promise<void>;
  clearError: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export const useKnowledge = create<KnowledgeState>((set, get) => {
  const schedulePoll = () => {
    if (pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void get().refresh();
    }, POLL_INTERVAL_MS);
  };

  const loadDocuments = async (id: string | null) => {
    if (!id) {
      set({ documents: [] });
      return;
    }
    try {
      const { documents } = await api.collectionDocuments(id);
      set({ documents });
    } catch {
      // Koleksiyon silinmiş olabilir; genel yenileme düzeltir.
      set({ documents: [] });
    }
  };

  return {
    overview: null,
    activeId: readLocal(ACTIVE_KEY),
    documents: [],
    sources: [],
    searching: false,
    uploading: null,
    error: null,

    clearError: () => set({ error: null }),

    refresh: async () => {
      try {
        const overview = await api.knowledge();
        const exists = overview.collections.some(
          (collection) => collection.id === get().activeId,
        );
        const activeId = exists
          ? get().activeId
          : (overview.collections[0]?.id ?? null);
        set({ overview, activeId, error: null });
        if (activeId) writeLocal(ACTIVE_KEY, activeId);
        await loadDocuments(activeId);
        if (overview.jobs.some((job: IngestJob) => job.status !== "done" && job.status !== "error")) {
          schedulePoll();
        }
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    select: async (id) => {
      set({ activeId: id, sources: [] });
      if (id) writeLocal(ACTIVE_KEY, id);
      await loadDocuments(id);
    },

    create: async (name, provider, model) => {
      try {
        const { collection } = await api.createCollection(name, provider, model);
        set({ activeId: collection.id });
        writeLocal(ACTIVE_KEY, collection.id);
        await get().refresh();
      } catch (err) {
        set({ error: (err as Error).message });
      }
    },

    rename: async (id, name) => {
      await api.renameCollection(id, name);
      await get().refresh();
    },

    remove: async (id) => {
      await api.deleteCollection(id);
      set({ activeId: null, documents: [], sources: [] });
      await get().refresh();
    },

    upload: async (file) => {
      const collectionId = get().activeId;
      if (!collectionId) {
        set({ error: "Önce bir koleksiyon seçin." });
        return;
      }
      const limit = get().overview?.maxUploadBytes ?? 0;
      if (limit && file.size > limit) {
        set({
          error: `${file.name} çok büyük (${Math.round(file.size / 1024 / 1024)} MB). ` +
            `En fazla ${Math.round(limit / 1024 / 1024)} MB.`,
        });
        return;
      }

      set({ uploading: file.name, error: null });
      try {
        const content = await toBase64(file);
        await api.uploadDocument(collectionId, file.name, content);
        await get().refresh();
      } catch (err) {
        set({ error: (err as Error).message });
      } finally {
        set({ uploading: null });
      }
    },

    removeDocument: async (id) => {
      await api.deleteKnowledgeDocument(id);
      await get().refresh();
    },

    testSearch: async (query) => {
      const collectionId = get().activeId;
      if (!collectionId || !query.trim()) return;
      set({ searching: true, error: null });
      try {
        const { sources } = await api.knowledgeSearch(collectionId, query);
        set({ sources });
      } catch (err) {
        set({ error: (err as Error).message, sources: [] });
      } finally {
        set({ searching: false });
      }
    },

    loadEmbedding: async (filename) => {
      set({ error: null });
      try {
        await api.loadEmbedding(filename);
      } catch (err) {
        set({ error: (err as Error).message });
      }
      await get().refresh();
    },

    unloadEmbedding: async () => {
      await api.unloadEmbedding();
      await get().refresh();
    },
  };
});

/**
 * Dosyayı base64'e çevirir. `FileReader` sonucu `data:` öneki taşır;
 * sunucu ham base64 bekler.
 */
async function toBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Tek seferde spread etmek büyük dosyada yığın taşırır.
  const step = 0x8000;
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step));
  }
  return btoa(binary);
}
