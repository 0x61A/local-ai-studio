import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { all, db, one, run } from "../store/db.js";
import type { Chunk } from "./chunk.js";
import type { DocumentKind } from "./extract.js";

/**
 * Bilgi tabanı deposu.
 *
 * Koleksiyon = tek bir gömme modeliyle indekslenmiş belge kümesi. Model
 * koleksiyona yazılır: farklı modellerin vektörleri aynı uzayda değildir,
 * karıştırmak sessizce saçma sonuç üretir. Koleksiyonun modeli
 * değiştirilemez; değiştirmek istenirse yeniden indeksleme gerekir.
 */

export type DocumentStatus =
  | "pending"
  | "extracting"
  | "embedding"
  | "ready"
  | "error";

export interface Collection {
  id: string;
  name: string;
  embedProvider: string;
  embedModel: string;
  dimensions: number;
  createdAt: number;
  documentCount: number;
  chunkCount: number;
}

export interface StoredDocument {
  id: string;
  collectionId: string;
  name: string;
  kind: DocumentKind;
  sizeBytes: number;
  pageCount: number;
  chunkCount: number;
  status: DocumentStatus;
  error: string;
  createdAt: number;
}

export interface StoredChunk {
  id: string;
  documentId: string;
  documentName: string;
  seq: number;
  page: number;
  heading: string;
  text: string;
}

/**
 * Vektör önbelleği bu sayacı izler. Koleksiyonun parçaları her
 * değiştiğinde artar; arama katmanı eski vektörlerle çalışmaz.
 */
const generations = new Map<string, number>();

export function generation(collectionId: string): number {
  return generations.get(collectionId) ?? 0;
}

function bump(collectionId: string): void {
  generations.set(collectionId, generation(collectionId) + 1);
}

// -- Koleksiyonlar ------------------------------------------------------------

export function createCollection(
  input: { name: string; embedProvider: string; embedModel: string },
  database: DatabaseSync = db(),
): Collection {
  const id = crypto.randomUUID();
  run(
    database,
    `INSERT INTO collections(id, name, embed_provider, embed_model, dimensions, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
    id,
    input.name.trim() || "Bilgi tabanı",
    input.embedProvider,
    input.embedModel,
    Date.now(),
  );
  return getCollection(id, database) as Collection;
}

const COLLECTION_SELECT = `
  SELECT c.id, c.name, c.embed_provider, c.embed_model, c.dimensions, c.created_at,
         (SELECT COUNT(*) FROM documents d WHERE d.collection_id = c.id) AS document_count,
         (SELECT COUNT(*) FROM chunks k WHERE k.collection_id = c.id) AS chunk_count
  FROM collections c`;

interface CollectionRow {
  id: string;
  name: string;
  embed_provider: string;
  embed_model: string;
  dimensions: number;
  created_at: number;
  document_count: number;
  chunk_count: number;
}

export function listCollections(database: DatabaseSync = db()): Collection[] {
  return all<CollectionRow>(database, `${COLLECTION_SELECT} ORDER BY c.created_at DESC`)
    .map(toCollection);
}

export function getCollection(
  id: string,
  database: DatabaseSync = db(),
): Collection | null {
  const row = one<CollectionRow>(database, `${COLLECTION_SELECT} WHERE c.id = ?`, id);
  return row ? toCollection(row) : null;
}

export function renameCollection(
  id: string,
  name: string,
  database: DatabaseSync = db(),
): void {
  run(database, "UPDATE collections SET name = ? WHERE id = ?", name.trim(), id);
}

export function deleteCollection(id: string, database: DatabaseSync = db()): void {
  run(database, "DELETE FROM collections WHERE id = ?", id);
  bump(id);
}

/** Koleksiyonun boyutu ilk gömmeyle sabitlenir. */
export function setDimensions(
  id: string,
  dimensions: number,
  database: DatabaseSync = db(),
): void {
  run(database, "UPDATE collections SET dimensions = ? WHERE id = ?", dimensions, id);
}

function toCollection(row: CollectionRow): Collection {
  return {
    id: row.id,
    name: row.name,
    embedProvider: row.embed_provider,
    embedModel: row.embed_model,
    dimensions: row.dimensions,
    createdAt: row.created_at,
    documentCount: row.document_count,
    chunkCount: row.chunk_count,
  };
}

// -- Belgeler -----------------------------------------------------------------

interface DocumentRow {
  id: string;
  collection_id: string;
  name: string;
  kind: string;
  size_bytes: number;
  page_count: number;
  chunk_count: number;
  status: string;
  error: string;
  created_at: number;
}

export function createDocument(
  input: { collectionId: string; name: string; kind: DocumentKind; sizeBytes: number },
  database: DatabaseSync = db(),
): StoredDocument {
  const id = crypto.randomUUID();
  run(
    database,
    `INSERT INTO documents(id, collection_id, name, kind, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.collectionId,
    input.name,
    input.kind,
    input.sizeBytes,
    Date.now(),
  );
  return getDocument(id, database) as StoredDocument;
}

export function getDocument(
  id: string,
  database: DatabaseSync = db(),
): StoredDocument | null {
  const row = one<DocumentRow>(database, "SELECT * FROM documents WHERE id = ?", id);
  return row ? toDocument(row) : null;
}

export function listDocuments(
  collectionId: string,
  database: DatabaseSync = db(),
): StoredDocument[] {
  return all<DocumentRow>(
    database,
    "SELECT * FROM documents WHERE collection_id = ? ORDER BY created_at DESC",
    collectionId,
  ).map(toDocument);
}

export function updateDocument(
  id: string,
  patch: Partial<Pick<StoredDocument, "status" | "error" | "pageCount" | "chunkCount">>,
  database: DatabaseSync = db(),
): void {
  const fields: string[] = [];
  const values: Array<string | number> = [];
  if (patch.status !== undefined) { fields.push("status = ?"); values.push(patch.status); }
  if (patch.error !== undefined) { fields.push("error = ?"); values.push(patch.error); }
  if (patch.pageCount !== undefined) { fields.push("page_count = ?"); values.push(patch.pageCount); }
  if (patch.chunkCount !== undefined) { fields.push("chunk_count = ?"); values.push(patch.chunkCount); }
  if (!fields.length) return;
  run(database, `UPDATE documents SET ${fields.join(", ")} WHERE id = ?`, ...values, id);
}

export function deleteDocument(id: string, database: DatabaseSync = db()): void {
  const row = one<{ collection_id: string }>(
    database,
    "SELECT collection_id FROM documents WHERE id = ?",
    id,
  );
  run(database, "DELETE FROM documents WHERE id = ?", id);
  if (row) bump(row.collection_id);
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    kind: row.kind as DocumentKind,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    chunkCount: row.chunk_count,
    status: row.status as DocumentStatus,
    error: row.error,
    createdAt: row.created_at,
  };
}

// -- Parçalar -----------------------------------------------------------------

export function insertChunks(
  collectionId: string,
  documentId: string,
  chunks: Array<Chunk & { embedding: Float32Array }>,
  database: DatabaseSync = db(),
): void {
  const statement = database.prepare(
    `INSERT INTO chunks(id, document_id, collection_id, seq, page, heading, text, embedding)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.exec("BEGIN");
  try {
    for (const chunk of chunks) {
      statement.run(
        crypto.randomUUID(),
        documentId,
        collectionId,
        chunk.seq,
        chunk.page,
        chunk.heading,
        chunk.text,
        toBlob(chunk.embedding),
      );
    }
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
  bump(collectionId);
}

export interface VectorSet {
  ids: string[];
  /** Tüm vektörler tek düz dizide: i. vektör [i*dim, (i+1)*dim). */
  data: Float32Array;
  dimensions: number;
}

/**
 * Koleksiyonun tüm vektörlerini tek düz dizide okur. Parça başına ayrı
 * Float32Array üretmek 50 bin parçada 50 bin nesne demektir; düz dizi hem
 * daha az bellek hem sıralı okuma sayesinde belirgin biçimde hızlı.
 */
export function loadVectors(
  collectionId: string,
  database: DatabaseSync = db(),
): VectorSet {
  const rows = all<{ id: string; embedding: Uint8Array }>(
    database,
    "SELECT id, embedding FROM chunks WHERE collection_id = ? AND embedding IS NOT NULL ORDER BY rowid",
    collectionId,
  );
  if (!rows.length) return { ids: [], data: new Float32Array(0), dimensions: 0 };

  const dimensions = (rows[0] as { embedding: Uint8Array }).embedding.byteLength / 4;
  const data = new Float32Array(rows.length * dimensions);
  const ids: string[] = [];
  let cursor = 0;

  for (const row of rows) {
    // Boyutu tutmayan kayıt sessizce hizayı kaydırır; atlanır.
    if (row.embedding.byteLength / 4 !== dimensions) continue;
    data.set(fromBlob(row.embedding), cursor * dimensions);
    ids.push(row.id);
    cursor += 1;
  }
  return { ids, data: data.subarray(0, cursor * dimensions), dimensions };
}

export function getChunks(
  ids: string[],
  database: DatabaseSync = db(),
): Map<string, StoredChunk> {
  const out = new Map<string, StoredChunk>();
  if (!ids.length) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = all<{
    id: string; document_id: string; document_name: string;
    seq: number; page: number; heading: string; text: string;
  }>(
    database,
    `SELECT k.id, k.document_id, d.name AS document_name, k.seq, k.page, k.heading, k.text
     FROM chunks k JOIN documents d ON d.id = k.document_id
     WHERE k.id IN (${placeholders})`,
    ...ids,
  );
  for (const row of rows) {
    out.set(row.id, {
      id: row.id,
      documentId: row.document_id,
      documentName: row.document_name,
      seq: row.seq,
      page: row.page,
      heading: row.heading,
      text: row.text,
    });
  }
  return out;
}

/** FTS eşleşmeleri, en iyiden kötüye sıralı parça kimlikleri. */
export function keywordMatches(
  collectionId: string,
  query: string,
  limit: number,
  database: DatabaseSync = db(),
): string[] {
  const expression = toFtsQuery(query);
  if (!expression) return [];
  try {
    return all<{ id: string }>(
      database,
      `SELECT k.id FROM chunks_fts f
       JOIN chunks k ON k.rowid = f.rowid
       WHERE chunks_fts MATCH ? AND k.collection_id = ?
       ORDER BY bm25(chunks_fts) LIMIT ?`,
      expression,
      collectionId,
      limit,
    ).map((row) => row.id);
  } catch {
    // FTS ifadesi yine de reddedilirse arama anlamsal tarafla devam eder.
    return [];
  }
}

/**
 * Kullanıcı metnini FTS sözdizimi olarak yorumlamayız: tırnak içine alınmış
 * terimler birleşimi kurulur. Aksi hâlde `"` ya da `NEAR` yazan bir soru
 * sorguyu bozardı.
 */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1)
    .slice(0, 24)
    .map((term) => `"${term.replace(/"/g, "")}"`);
  return terms.length ? terms.join(" OR ") : "";
}

function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice();
}

function fromBlob(blob: Uint8Array): Float32Array {
  const copy = blob.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
