import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "../config.js";

/**
 * Tek SQLite dosyası: ayarlar, konuşmalar, mesajlar, sır meta verisi.
 *
 * Node 24'ün yerleşik `node:sqlite`'ı kullanılır. Native npm modülü yok --
 * prebuild matrisi sıfır-kurulum vaadini bozardı.
 */

let handle: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (handle) return handle;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  handle = open(path.join(DATA_DIR, "studio.db"));
  return handle;
}

/** Testler bellek içi veritabanı açar. */
export function open(filename: string): DatabaseSync {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  migrate(database);
  return database;
}

export function closeDb(): void {
  handle?.close();
  handle = null;
}

/**
 * Sürüm numaralı, ileri yönlü göçler. Her göç bir kez çalışır;
 * `user_version` pragma'sı ilerlemeyi tutar.
 */
const MIGRATIONS: Array<(database: DatabaseSync) => void> = [
  (database) => {
    database.exec(`
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE conversations (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        provider   TEXT NOT NULL DEFAULT '',
        model      TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_conversations_updated
        ON conversations(archived, updated_at DESC);

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        reasoning       TEXT NOT NULL DEFAULT '',
        created_at      INTEGER NOT NULL,
        seq             INTEGER NOT NULL
      );
      CREATE INDEX idx_messages_conversation
        ON messages(conversation_id, seq);

      CREATE TABLE conversation_tags (
        conversation_id TEXT NOT NULL
          REFERENCES conversations(id) ON DELETE CASCADE,
        tag             TEXT NOT NULL,
        PRIMARY KEY (conversation_id, tag)
      );

      -- Tam metin arama. İçerik messages tablosunda kalır; FTS yalnızca
      -- indeks tutar (external content table).
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );

      CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  },
  (database) => {
    database.exec(`
      CREATE TABLE collections (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        embed_provider TEXT NOT NULL DEFAULT '',
        embed_model    TEXT NOT NULL DEFAULT '',
        dimensions     INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL
      );

      CREATE TABLE documents (
        id            TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL
          REFERENCES collections(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL DEFAULT 0,
        page_count    INTEGER NOT NULL DEFAULT 0,
        chunk_count   INTEGER NOT NULL DEFAULT 0,
        -- pending | extracting | embedding | ready | error
        status        TEXT NOT NULL DEFAULT 'pending',
        error         TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_documents_collection
        ON documents(collection_id, created_at DESC);

      -- Gomme vektoru ham Float32 dizisi olarak saklanir. Ayni makinede
      -- yazilip okundugu icin bayt sirasi sorun degil; tasinabilirlik
      -- gerekirse donusum tek yerde (rag/store.ts) yapilir.
      CREATE TABLE chunks (
        id            TEXT PRIMARY KEY,
        document_id   TEXT NOT NULL
          REFERENCES documents(id) ON DELETE CASCADE,
        collection_id TEXT NOT NULL
          REFERENCES collections(id) ON DELETE CASCADE,
        seq           INTEGER NOT NULL,
        page          INTEGER NOT NULL DEFAULT 1,
        heading       TEXT NOT NULL DEFAULT '',
        text          TEXT NOT NULL,
        embedding     BLOB
      );
      CREATE INDEX idx_chunks_collection ON chunks(collection_id);
      CREATE INDEX idx_chunks_document ON chunks(document_id, seq);

      -- Anlamsal arama tek basina sayilari ve ozel adlari kacirir; FTS
      -- indeksi birebir terim eslesmesini geri getirir (bkz. rag/search.ts).
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='rowid'
      );

      CREATE TRIGGER chunks_fts_insert AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER chunks_fts_delete AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER chunks_fts_update AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text)
        VALUES ('delete', old.rowid, old.text);
        INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
    `);
  },
  (database) => {
    database.exec(`
      -- Uretim parametreleri goruntunun yaninda durur: ayni sonucu yeniden
      -- uretmek icin gereken her sey (tohum dahil) burada.
      CREATE TABLE images (
        id              TEXT PRIMARY KEY,
        filename        TEXT NOT NULL,
        prompt          TEXT NOT NULL,
        negative_prompt TEXT NOT NULL DEFAULT '',
        model           TEXT NOT NULL DEFAULT '',
        sampler         TEXT NOT NULL DEFAULT '',
        scheduler       TEXT NOT NULL DEFAULT '',
        steps           INTEGER NOT NULL DEFAULT 0,
        cfg_scale       REAL NOT NULL DEFAULT 0,
        seed            INTEGER NOT NULL DEFAULT -1,
        width           INTEGER NOT NULL DEFAULT 0,
        height          INTEGER NOT NULL DEFAULT 0,
        -- txt2img | img2img
        source          TEXT NOT NULL DEFAULT 'txt2img',
        parent_id       TEXT REFERENCES images(id) ON DELETE SET NULL,
        hires           INTEGER NOT NULL DEFAULT 0,
        ms              INTEGER NOT NULL DEFAULT 0,
        favorite        INTEGER NOT NULL DEFAULT 0,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_images_created ON images(created_at DESC);

      CREATE VIRTUAL TABLE images_fts USING fts5(
        prompt,
        content='images',
        content_rowid='rowid'
      );

      CREATE TRIGGER images_fts_insert AFTER INSERT ON images BEGIN
        INSERT INTO images_fts(rowid, prompt) VALUES (new.rowid, new.prompt);
      END;
      CREATE TRIGGER images_fts_delete AFTER DELETE ON images BEGIN
        INSERT INTO images_fts(images_fts, rowid, prompt)
        VALUES ('delete', old.rowid, old.prompt);
      END;
      CREATE TRIGGER images_fts_update AFTER UPDATE ON images BEGIN
        INSERT INTO images_fts(images_fts, rowid, prompt)
        VALUES ('delete', old.rowid, old.prompt);
        INSERT INTO images_fts(rowid, prompt) VALUES (new.rowid, new.prompt);
      END;
    `);
  },
];

function migrate(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  let version = row.user_version;

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index];
    if (!migration) continue;
    database.exec("BEGIN");
    try {
      migration(database);
      // Pragma parametre kabul etmez; değer kod içinden gelen bir tamsayı.
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw new Error(`Göç ${index + 1} başarısız: ${(err as Error).message}`);
    }
    version = index + 1;
  }
}

/**
 * Tipli sorgu yardımcıları. `node:sqlite` satırları
 * `Record<string, SQLOutputValue>` olarak döner; dönüşüm tek yerde yapılsın
 * diye her çağrı buradan geçer.
 */
export function all<T>(
  database: DatabaseSync,
  sql: string,
  ...params: SqlParam[]
): T[] {
  return database.prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(
  database: DatabaseSync,
  sql: string,
  ...params: SqlParam[]
): T | null {
  return (database.prepare(sql).get(...params) as unknown as T | undefined) ?? null;
}

export function run(
  database: DatabaseSync,
  sql: string,
  ...params: SqlParam[]
): void {
  database.prepare(sql).run(...params);
}

export type SqlParam = string | number | bigint | null | Uint8Array;

export function currentSchemaVersion(): number {
  return MIGRATIONS.length;
}
