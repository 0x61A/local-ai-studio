import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { all, db, one, run } from "../store/db.js";
import { toFtsQuery } from "../rag/store.js";

/** Görsel galerisi: dosya diskte, üretim parametreleri veritabanında. */

export type ImageSource = "txt2img" | "img2img";

export interface StoredImage {
  id: string;
  filename: string;
  prompt: string;
  negativePrompt: string;
  model: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfgScale: number;
  seed: number;
  width: number;
  height: number;
  source: ImageSource;
  parentId: string | null;
  hires: boolean;
  ms: number;
  favorite: boolean;
  createdAt: number;
}

interface ImageRow {
  id: string;
  filename: string;
  prompt: string;
  negative_prompt: string;
  model: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfg_scale: number;
  seed: number;
  width: number;
  height: number;
  source: string;
  parent_id: string | null;
  hires: number;
  ms: number;
  favorite: number;
  created_at: number;
}

export function insertImage(
  input: Omit<StoredImage, "id" | "createdAt" | "favorite">,
  database: DatabaseSync = db(),
): StoredImage {
  const id = crypto.randomUUID();
  run(
    database,
    `INSERT INTO images(
       id, filename, prompt, negative_prompt, model, sampler, scheduler,
       steps, cfg_scale, seed, width, height, source, parent_id, hires, ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.filename,
    input.prompt,
    input.negativePrompt,
    input.model,
    input.sampler,
    input.scheduler,
    input.steps,
    input.cfgScale,
    input.seed,
    input.width,
    input.height,
    input.source,
    input.parentId,
    input.hires ? 1 : 0,
    input.ms,
    Date.now(),
  );
  return getImage(id, database) as StoredImage;
}

export function getImage(id: string, database: DatabaseSync = db()): StoredImage | null {
  const row = one<ImageRow>(database, "SELECT * FROM images WHERE id = ?", id);
  return row ? toImage(row) : null;
}

export function listImages(
  options: { limit?: number; favoritesOnly?: boolean } = {},
  database: DatabaseSync = db(),
): StoredImage[] {
  const limit = Math.min(options.limit ?? 200, 500);
  const where = options.favoritesOnly ? "WHERE favorite = 1" : "";
  // rowid ikinci sıralama anahtarı: bir yığındaki görseller aynı
  // milisaniyede kaydedilir, yalnızca zamana bakmak sırayı rastgele bırakır.
  return all<ImageRow>(
    database,
    `SELECT * FROM images ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    limit,
  ).map(toImage);
}

/** İstem üzerinde tam metin arama. Girdi FTS sözdizimi olarak yorumlanmaz. */
export function searchImages(
  query: string,
  limit = 100,
  database: DatabaseSync = db(),
): StoredImage[] {
  const expression = toFtsQuery(query);
  if (!expression) return [];
  try {
    return all<ImageRow>(
      database,
      `SELECT i.* FROM images_fts f
       JOIN images i ON i.rowid = f.rowid
       WHERE images_fts MATCH ?
       ORDER BY bm25(images_fts) LIMIT ?`,
      expression,
      limit,
    ).map(toImage);
  } catch {
    return [];
  }
}

export function setFavorite(
  id: string,
  favorite: boolean,
  database: DatabaseSync = db(),
): void {
  run(database, "UPDATE images SET favorite = ? WHERE id = ?", favorite ? 1 : 0, id);
}

export function deleteImage(id: string, database: DatabaseSync = db()): StoredImage | null {
  const image = getImage(id, database);
  if (image) run(database, "DELETE FROM images WHERE id = ?", id);
  return image;
}

function toImage(row: ImageRow): StoredImage {
  return {
    id: row.id,
    filename: row.filename,
    prompt: row.prompt,
    negativePrompt: row.negative_prompt,
    model: row.model,
    sampler: row.sampler,
    scheduler: row.scheduler,
    steps: row.steps,
    cfgScale: row.cfg_scale,
    seed: row.seed,
    width: row.width,
    height: row.height,
    source: row.source as ImageSource,
    parentId: row.parent_id,
    hires: row.hires === 1,
    ms: row.ms,
    favorite: row.favorite === 1,
    createdAt: row.created_at,
  };
}
