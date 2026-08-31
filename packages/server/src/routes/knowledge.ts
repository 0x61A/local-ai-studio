import { z } from "zod";
import {
  embeddingBaseUrl,
  embeddingStatus,
  startEmbedding,
  stopEmbedding,
} from "../engines/embedding.js";
import { getBudget } from "../hardware/budget.js";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import { PROVIDER_IDS } from "../providers/types.js";
import { supportedExtensions } from "../rag/extract.js";
import {
  IngestError,
  clearFinishedJobs,
  enqueueDocument,
  ingestJobs,
  removeDocument,
} from "../rag/ingest.js";
import { searchCollection, toSourceRefs } from "../rag/search.js";
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  listDocuments,
  renameCollection,
} from "../rag/store.js";
import { listLocalModels } from "./models.js";

/**
 * Bilgi tabanı uçları.
 *
 * Dosya yüklemesi base64 gövdeyle gelir. Sunucuya "şu yoldaki dosyayı
 * indeksle" dedirtmiyoruz: bu, yerel ağdaki her isteğe keyfi dosya okuma
 * yetkisi verirdi. Kullanıcı dosyayı tarayıcının seçicisinden verir.
 */

const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const CreateCollectionBody = z.object({
  name: z.string().min(1).max(120),
  embedProvider: z.enum(PROVIDER_IDS),
  embedModel: z.string().min(1).max(200),
});

const UploadBody = z.object({
  name: z.string().min(1).max(255),
  /** Dosya içeriği base64. */
  content: z.string().min(1),
});

const SearchBody = z.object({
  collectionId: z.string().uuid(),
  query: z.string().min(1).max(2000),
  topK: z.number().int().min(1).max(20).optional(),
});

export function registerKnowledgeRoutes(router: Router): void {
  router.get("/api/knowledge", {}, () => ({
    collections: listCollections(),
    jobs: ingestJobs(),
    embedding: {
      ...embeddingStatus(),
      ready: embeddingBaseUrl() !== null,
      budget: getBudget(),
    },
    localEmbeddingModels: listLocalModels().filter((model) => model.isEmbedding),
    supportedExtensions: supportedExtensions(),
    maxUploadBytes: MAX_UPLOAD_BYTES,
  }));

  router.post("/api/knowledge/collections", { body: CreateCollectionBody }, ({ body }) => ({
    collection: createCollection(body),
  }));

  router.post(
    "/api/knowledge/collections/:id/rename",
    { body: z.object({ name: z.string().min(1).max(120) }) },
    ({ params, body }) => {
      requireCollection(params["id"] as string);
      renameCollection(params["id"] as string, body.name);
      return { collection: getCollection(params["id"] as string) };
    },
  );

  router.del("/api/knowledge/collections/:id", {}, ({ params }) => {
    requireCollection(params["id"] as string);
    deleteCollection(params["id"] as string);
    return { collections: listCollections() };
  });

  router.get("/api/knowledge/collections/:id/documents", {}, ({ params }) => {
    requireCollection(params["id"] as string);
    return { documents: listDocuments(params["id"] as string) };
  });

  router.post(
    "/api/knowledge/collections/:id/documents",
    { body: UploadBody },
    ({ params, body }) => {
      const collection = requireCollection(params["id"] as string);
      const bytes = decodeUpload(body.content);
      try {
        return {
          document: enqueueDocument({
            collectionId: collection.id,
            name: body.name,
            bytes,
          }),
        };
      } catch (err) {
        if (err instanceof IngestError) {
          throw HttpError.badRequest("bad_document", err.message);
        }
        throw err;
      }
    },
  );

  router.del("/api/knowledge/documents/:id", {}, ({ params }) => {
    removeDocument(params["id"] as string);
    return { ok: true };
  });

  router.get("/api/knowledge/jobs", {}, () => ({ jobs: ingestJobs() }));

  router.post("/api/knowledge/jobs/clear", {}, () => {
    clearFinishedJobs();
    return { jobs: ingestJobs() };
  });

  router.post("/api/knowledge/search", { body: SearchBody }, async ({ body }) => {
    const collection = requireCollection(body.collectionId);
    const hits = await searchCollection(
      collection.id,
      { provider: collection.embedProvider as never, model: collection.embedModel },
      body.query,
      body.topK ? { topK: body.topK } : {},
    );
    return { sources: toSourceRefs(hits, body.query) };
  });

  // -- Gömme motoru ----------------------------------------------------------

  router.post(
    "/api/knowledge/embedding/load",
    { body: z.object({ filename: z.string().min(1).max(255) }) },
    async ({ body }) => {
      try {
        return { embedding: await startEmbedding(body.filename) };
      } catch (err) {
        throw HttpError.badRequest("embedding_load_failed", (err as Error).message);
      }
    },
  );

  router.post("/api/knowledge/embedding/unload", {}, async () => ({
    embedding: await stopEmbedding(),
  }));
}

function requireCollection(id: string) {
  const collection = getCollection(id);
  if (!collection) throw HttpError.notFound("Koleksiyon bulunamadı.");
  return collection;
}

function decodeUpload(content: string): Buffer {
  // base64 dört karakterde üç bayt taşır; çözmeden önce boyutu kestiririz
  // ki 24 MB sınırını aşan gövde belleğe iki kez alınmasın.
  if ((content.length / 4) * 3 > MAX_UPLOAD_BYTES) {
    throw HttpError.badRequest(
      "file_too_large",
      `Dosya çok büyük. En fazla ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`,
    );
  }
  const bytes = Buffer.from(content, "base64");
  if (!bytes.byteLength) {
    throw HttpError.badRequest("empty_file", "Dosya boş ya da base64 çözülemedi.");
  }
  return bytes;
}
