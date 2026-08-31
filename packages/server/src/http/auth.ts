import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.js";

/**
 * Yerel sunucu icin uc katmanli koruma. Eski projedeki S1/S2/S3'u kapatir:
 *  1. Sunucu zaten yalnizca 127.0.0.1'e bind edilir (main.ts).
 *  2. Origin / Sec-Fetch-Site dogrulamasi -> baska bir site API'yi cagiramaz.
 *     CORS basligi hic gonderilmez; tarayici yaniti okuyamaz.
 *  3. Oturum token'i -> ayni makinedeki baska bir surec de cagiramaz.
 */
export function assertAuthorized(
  req: IncomingMessage,
  expectedToken: string,
  port: number,
): void {
  assertSameOrigin(req, port);

  const provided = extractToken(req);
  if (!provided || !timingSafeEquals(provided, expectedToken)) {
    throw HttpError.unauthorized();
  }
}

/**
 * Statik kabuk (HTML/JS) icin: token yok ama capraz-site istegi de olmamali.
 * Tarayici ilk yuklemede token'i henuz bilmez -- token URL fragment'inda gelir
 * ve fragment sunucuya gonderilmez.
 */
export function assertSameOrigin(req: IncomingMessage, port: number): void {
  const site = header(req, "sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw HttpError.forbidden("cross_site", "Capraz site istekleri reddedilir.");
  }

  const origin = header(req, "origin");
  if (origin && !isAllowedOrigin(origin, port)) {
    throw HttpError.forbidden("bad_origin", `Izin verilmeyen Origin: ${origin}`);
  }

  // DNS rebinding korumasi: Host basligi loopback olmali.
  const host = header(req, "host");
  if (host && !isLoopbackHost(host, port)) {
    throw HttpError.forbidden("bad_host", `Izin verilmeyen Host: ${host}`);
  }
}

function isAllowedOrigin(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && isLoopbackHost(url.host, port);
  } catch {
    return false;
  }
}

function isLoopbackHost(host: string, port: number): boolean {
  const [name, hostPort] = splitHost(host);
  if (hostPort && hostPort !== String(port)) return false;
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

function splitHost(host: string): [string, string | null] {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return [host, null];
    const name = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    return [name, rest.startsWith(":") ? rest.slice(1) : null];
  }
  const idx = host.lastIndexOf(":");
  if (idx === -1) return [host, null];
  return [host.slice(0, idx), host.slice(idx + 1)];
}

function extractToken(req: IncomingMessage): string | null {
  const auth = header(req, "authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return null;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
