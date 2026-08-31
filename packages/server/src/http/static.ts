import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { PathEscapeError, resolveInside } from "../security/paths.js";
import { HttpError } from "./errors.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/**
 * Statik dosya servisi. Eski projedeki S4'u (path traversal) kapatir:
 * her yol resolveInside()'dan gecer, kok disina cikan istek 403 doner.
 */
export async function serveStatic(
  res: ServerResponse,
  distDir: string,
  pathname: string,
): Promise<void> {
  let requested: string;
  try {
    // Once coz, sonra dogrula. URL ayristiricisi "/../x" gibi yollari
    // normalize eder ama "%2f" ile kodlanmis egik cizgiler hayatta kalir --
    // gercek engel resolveInside()'dir.
    requested = decodeURIComponent(pathname);
  } catch {
    throw HttpError.badRequest("bad_path", "Dosya yolu gecerli kodlanmamis.");
  }
  if (requested === "/") requested = "index.html";
  if (requested.includes("\0")) {
    throw HttpError.forbidden("path_escape", "Gecersiz dosya yolu.");
  }

  let filePath: string;
  try {
    filePath = resolveInside(distDir, requested);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      throw HttpError.forbidden("path_escape", "Gecersiz dosya yolu.");
    }
    throw err;
  }

  if (!isReadableFile(filePath)) {
    // SPA geri dusumu: bilinmeyen yollar uygulama kabugunu alir.
    filePath = path.join(distDir, "index.html");
    if (!isReadableFile(filePath)) {
      throw HttpError.notFound(
        "Web arayuzu derlenmemis. `npm run build` calistirin.",
      );
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  const data = await fsp.readFile(filePath);
  const isHashedAsset = /\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2)$/.test(filePath);

  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": data.byteLength,
    "cache-control": isHashedAsset
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "x-content-type-options": "nosniff",
    // Kabuk yalnizca kendi kaynagindan sey yukler; harici istek yok.
    "content-security-policy":
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  });
  res.end(data);
}

function isReadableFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
