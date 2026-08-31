import type { DatabaseSync } from "node:sqlite";
import { all, db, one, run } from "./db.js";

/**
 * Anahtar/değer ayar deposu. Değerler JSON olarak saklanır; okuyan taraf
 * beklediği şemayı kendisi doğrular (bkz. routes/settings.ts).
 */

export function getSetting<T>(key: string, fallback: T, database?: DatabaseSync): T {
  const row = one<{ value: string }>(
    database ?? db(),
    "SELECT value FROM settings WHERE key = ?",
    key,
  );
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown, database?: DatabaseSync): void {
  run(
    database ?? db(),
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    JSON.stringify(value),
  );
}

export function deleteSetting(key: string, database?: DatabaseSync): void {
  run(database ?? db(), "DELETE FROM settings WHERE key = ?", key);
}

export function allSettings(database?: DatabaseSync): Record<string, unknown> {
  const rows = all<{ key: string; value: string }>(
    database ?? db(),
    "SELECT key, value FROM settings",
  );
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      // Bozuk kayıt sessizce atlanır; ayar varsayılanına düşer.
    }
  }
  return out;
}
