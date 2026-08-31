import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DATA_DIR } from "../config.js";
import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting, deleteSetting } from "../store/settings.js";

/**
 * API anahtarı deposu.
 *
 * Tasarım kararı: API anahtarları hiçbir zaman komut satırı argümanı olmaz.
 * `ps` çıktısı aynı kullanıcının süreç argv'sini gösterir; `security
 * add-generic-password -w <anahtar>` çağırmak anahtarı oraya sızdırırdı.
 *
 * Bunun yerine:
 *  1. Rastgele 32 baytlık bir ana anahtar üretilir ve macOS Keychain'de
 *     saklanır (fallback: 0600 izinli dosya).
 *  2. API anahtarları bu ana anahtarla AES-256-GCM ile şifrelenip
 *     veritabanına yazılır.
 *
 * Argv'ye yalnızca rastgele ana anahtar düşer; onu görebilen bir saldırgan
 * zaten Keychain'i de bizim kimliğimizle okuyabilir.
 */

const KEYCHAIN_SERVICE = "local-ai-studio";
const KEYCHAIN_ACCOUNT = "master-key";
const FALLBACK_KEY_FILE = path.join(DATA_DIR, ".master-key");
const SETTING_PREFIX = "secret:";

export interface SecretInfo {
  name: string;
  /** Tam değer asla dönmez; yalnızca tanımaya yetecek kadarı. */
  masked: string;
  updatedAt: number;
}

export interface StoredSecret {
  iv: string;
  tag: string;
  data: string;
  masked: string;
  updatedAt: number;
}

let cachedMasterKey: Buffer | null = null;

/** Saf şifreleme çekirdeği. Keychain'e ya da veritabanına dokunmaz. */
export function encryptSecret(key: Buffer, value: string): StoredSecret {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    masked: maskSecret(value),
    updatedAt: Date.now(),
  };
}

/** Çözemezse null döner: yanlış anahtar, bozuk kayıt ya da kurcalanmış etiket. */
export function decryptSecret(key: Buffer, record: StoredSecret): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

export function setSecret(
  name: string,
  value: string,
  database?: DatabaseSync,
): SecretInfo {
  const key = assertName(name);
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Boş bir API anahtarı saklanamaz.");
  }
  const record = encryptSecret(masterKey(), trimmed);
  setSetting(SETTING_PREFIX + key, record, database);
  return { name: key, masked: record.masked, updatedAt: record.updatedAt };
}

export function getSecret(name: string, database?: DatabaseSync): string | null {
  const record = getSetting<StoredSecret | null>(
    SETTING_PREFIX + assertName(name),
    null,
    database,
  );
  if (!record) return null;
  // Çözülemezse null: ana anahtar değişmiş ya da kayıt bozulmuş. Anahtarı
  // yeniden istemek, sessizce yanlış anahtarla istek atmaktan iyidir.
  return decryptSecret(masterKey(), record);
}

export function describeSecret(
  name: string,
  database?: DatabaseSync,
): SecretInfo | null {
  const record = getSetting<StoredSecret | null>(
    SETTING_PREFIX + assertName(name),
    null,
    database,
  );
  return record
    ? { name, masked: record.masked, updatedAt: record.updatedAt }
    : null;
}

export function deleteSecret(name: string, database?: DatabaseSync): void {
  deleteSetting(SETTING_PREFIX + assertName(name), database);
}

export function hasSecret(name: string, database?: DatabaseSync): boolean {
  return describeSecret(name, database) !== null;
}

/** "sk-proj-abc…9f2a" — tanımaya yeter, kullanmaya yetmez. */
export function maskSecret(value: string): string {
  const text = value.trim();
  if (text.length <= 8) return "•".repeat(text.length);
  return `${text.slice(0, 5)}…${text.slice(-4)}`;
}

// -- Ana anahtar --------------------------------------------------------------

function masterKey(): Buffer {
  if (cachedMasterKey) return cachedMasterKey;

  const existing = readMasterKey();
  if (existing) {
    cachedMasterKey = existing;
    return existing;
  }

  const created = crypto.randomBytes(32);
  writeMasterKey(created);
  cachedMasterKey = created;
  return created;
}

function readMasterKey(): Buffer | null {
  if (os.platform() === "darwin") {
    const fromKeychain = runSecurity([
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
      "-w",
    ]);
    if (fromKeychain) return Buffer.from(fromKeychain.trim(), "base64");
  }
  try {
    const raw = fs.readFileSync(FALLBACK_KEY_FILE, "utf8").trim();
    if (raw) return Buffer.from(raw, "base64");
  } catch {
    // Dosya yok: ilk çalıştırma.
  }
  return null;
}

function writeMasterKey(key: Buffer): void {
  const encoded = key.toString("base64");

  if (os.platform() === "darwin") {
    const stored = runSecurity([
      "add-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-a", KEYCHAIN_ACCOUNT,
      "-w", encoded,
      "-U",
    ]);
    if (stored !== null) return;
    console.warn(
      "  [secrets] Keychain kullanılamadı; ana anahtar 0600 izinli dosyaya yazılıyor.",
    );
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FALLBACK_KEY_FILE, encoded, { mode: 0o600 });
  fs.chmodSync(FALLBACK_KEY_FILE, 0o600);
}

/** Başarıda stdout, başarısızlıkta null. Kabuk kullanılmaz. */
function runSecurity(args: string[]): string | null {
  try {
    return execFileSync("security", args, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Ayar anahtarına gömüleceği için ad kısıtlıdır. */
export function assertName(name: string): string {
  const cleaned = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(cleaned)) {
    throw new Error(`Geçersiz sır adı: ${name}`);
  }
  return cleaned;
}

/** Testler için: önbelleği temizler, sonraki çağrı anahtarı yeniden okur. */
export function resetMasterKeyCache(): void {
  cachedMasterKey = null;
}
