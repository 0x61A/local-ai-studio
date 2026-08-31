import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Proje kokunu bulur. Launcher STUDIO_ROOT verir; vermezse bu dosyanin
 * konumundan yukari yuruyup package.json + packages/ ikilisini arar.
 */
function findRoot(): string {
  const fromEnv = process.env["STUDIO_ROOT"];
  if (fromEnv && fs.existsSync(path.join(fromEnv, "package.json"))) {
    return path.resolve(fromEnv);
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Proje koku bulunamadi. STUDIO_ROOT ortam degiskenini ayarlayin.",
  );
}

export const ROOT = findRoot();
export const WEB_DIST = path.join(ROOT, "packages", "web", "dist");
export const DATA_DIR = path.join(ROOT, "data");
export const RUNTIME_DIR = path.join(ROOT, "runtime");
export const MODELS_DIR = path.join(DATA_DIR, "models");
/** Görsel modelleri ayrı durur: metin modeli listesine karışmamalı. */
export const IMAGE_MODELS_DIR = path.join(MODELS_DIR, "image");
export const OUTPUTS_DIR = path.join(DATA_DIR, "outputs");
/** Motor süreçlerinin kimlikleri; çökme sonrası yetim kalanları toplamak için. */
export const ENGINE_PID_FILE = path.join(DATA_DIR, "engine-pids.json");

export const APP_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Istenen port; mesgulse main.ts sirayla bir sonrakini dener. */
export const PREFERRED_PORT = (() => {
  const raw = Number.parseInt(process.env["STUDIO_PORT"] ?? "", 10);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : 7420;
})();

/**
 * Her baslangicta yeni bir oturum token'i. Diske yazilmaz; launcher onu
 * stdout'tan okuyup tarayici URL'sinin fragment'ina koyar.
 */
export const SESSION_TOKEN = crypto.randomBytes(32).toString("base64url");

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, MODELS_DIR, IMAGE_MODELS_DIR, OUTPUTS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
