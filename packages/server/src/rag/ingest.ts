import { chunkDocument } from "./chunk.js";
import { embedTexts, type EmbedSpec } from "./embed.js";
import { ExtractError, extractDocument, kindFor } from "./extract.js";
import { invalidateVectorCache } from "./search.js";
import {
  createDocument,
  deleteDocument,
  getCollection,
  insertChunks,
  setDimensions,
  updateDocument,
  type StoredDocument,
} from "./store.js";

/**
 * Belge alma hattı: çıkar -> parçala -> göm -> sakla.
 *
 * İşler sıraya alınır ve teker teker koşar. Eşzamanlı gömme, yerel motoru
 * aynı anda birden çok yığınla doldurur; hız kazandırmaz, bellek tepe
 * noktasını yükseltir.
 */

export interface IngestJob {
  documentId: string;
  collectionId: string;
  name: string;
  status: "queued" | "extracting" | "embedding" | "done" | "error";
  /** 0-100. Gömme aşamasında parça sayısına göre ilerler. */
  progress: number;
  chunkCount: number;
  error: string | null;
}

const jobs = new Map<string, IngestJob>();
let queue: Promise<void> = Promise.resolve();

export function ingestJobs(): IngestJob[] {
  return [...jobs.values()];
}

export function clearFinishedJobs(): void {
  for (const [id, job] of jobs) {
    if (job.status === "done" || job.status === "error") jobs.delete(id);
  }
}

export class IngestError extends Error {}

/**
 * Belgeyi kuyruğa alır ve kaydı hemen döner. Arayüz ilerlemeyi
 * `/api/knowledge/jobs` üzerinden izler.
 */
export function enqueueDocument(input: {
  collectionId: string;
  name: string;
  bytes: Buffer;
}): StoredDocument {
  const collection = getCollection(input.collectionId);
  if (!collection) throw new IngestError("Koleksiyon bulunamadı.");

  const kind = kindFor(input.name);
  if (!kind) {
    throw new IngestError(
      `Desteklenmeyen dosya türü: ${input.name}. PDF, DOCX, Markdown, düz metin ve kod dosyaları alınabilir.`,
    );
  }

  const document = createDocument({
    collectionId: collection.id,
    name: input.name,
    kind,
    sizeBytes: input.bytes.byteLength,
  });

  jobs.set(document.id, {
    documentId: document.id,
    collectionId: collection.id,
    name: input.name,
    status: "queued",
    progress: 0,
    chunkCount: 0,
    error: null,
  });

  const spec: EmbedSpec = {
    provider: collection.embedProvider as EmbedSpec["provider"],
    model: collection.embedModel,
  };
  queue = queue.then(() =>
    process(document.id, input.bytes, input.name, collection.id, spec, collection.dimensions),
  );
  return document;
}

async function process(
  documentId: string,
  bytes: Buffer,
  name: string,
  collectionId: string,
  spec: EmbedSpec,
  knownDimensions: number,
): Promise<void> {
  const job = jobs.get(documentId);
  if (!job) return;

  const fail = (message: string) => {
    job.status = "error";
    job.error = message;
    updateDocument(documentId, { status: "error", error: message });
  };

  try {
    job.status = "extracting";
    updateDocument(documentId, { status: "extracting" });
    const extracted = await extractDocument(name, bytes);

    const chunks = chunkDocument(extracted);
    if (!chunks.length) {
      fail("Belgeden parça çıkmadı; içerik boş olabilir.");
      return;
    }
    job.chunkCount = chunks.length;
    updateDocument(documentId, {
      pageCount: extracted.pages.length,
      chunkCount: chunks.length,
      status: "embedding",
    });
    job.status = "embedding";

    // Parça parça gömüp ilerlemeyi bildiririz: 500 parçalık bir PDF'te
    // tek seferlik bekleme kullanıcıya donmuş gibi görünürdü.
    const embedded: Array<(typeof chunks)[number] & { embedding: Float32Array }> = [];
    const step = 32;
    for (let at = 0; at < chunks.length; at += step) {
      const slice = chunks.slice(at, at + step);
      const vectors = await embedTexts(spec, slice.map((chunk) => chunk.text));
      slice.forEach((chunk, index) => {
        embedded.push({ ...chunk, embedding: vectors[index] as Float32Array });
      });
      job.progress = Math.round((embedded.length / chunks.length) * 100);
    }

    const dimensions = (embedded[0] as { embedding: Float32Array }).embedding.length;
    if (knownDimensions > 0 && knownDimensions !== dimensions) {
      fail(
        `Bu koleksiyon ${knownDimensions} boyutlu vektörlerle kuruldu, gelen vektör ` +
          `${dimensions} boyutlu. Gömme modeli değişmiş; yeni bir koleksiyon açın.`,
      );
      return;
    }

    insertChunks(collectionId, documentId, embedded);
    if (knownDimensions === 0) setDimensions(collectionId, dimensions);
    invalidateVectorCache(collectionId);

    job.status = "done";
    job.progress = 100;
    updateDocument(documentId, { status: "ready", error: "", chunkCount: embedded.length });
  } catch (err) {
    fail(err instanceof ExtractError ? err.message : `Alma başarısız: ${(err as Error).message}`);
  }
}

/** Belgeyi ve parçalarını siler; devam eden işi de listeden düşürür. */
export function removeDocument(documentId: string): void {
  jobs.delete(documentId);
  deleteDocument(documentId);
  invalidateVectorCache();
}
