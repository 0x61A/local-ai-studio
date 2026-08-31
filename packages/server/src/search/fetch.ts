import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF korumalı sayfa çekme.
 *
 * Ajan istediği adresi çekebilir; adresin kaynağı model çıktısıdır, yani
 * güvenilmez. Koruma iki aşamalı:
 *  1. Ad çözümlemesi yapılır ve dönen HER IP özel aralık kontrolünden geçer.
 *  2. Yönlendirmeler elle takip edilir ve her adım yeniden kontrol edilir --
 *     aksi hâlde açık bir yönlendirme kontrolü atlatırdı.
 *
 * Referans projedeki koruma yalnızca ilk adresi kontrol ediyordu.
 */

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Apple Silicon) LocalAIStudio/1.0";

export class FetchBlockedError extends Error {}

export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local / bulut metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (family === 6) {
    const value = ip.toLowerCase().replace(/^\[|\]$/g, "");
    return (
      value === "::" ||
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80") ||
      // IPv4 eşlemeli adresler IPv4 kuralına düşer.
      (value.startsWith("::ffff:") && isPrivateIp(value.slice(7)))
    );
  }
  return true; // ayrıştırılamayan adres güvenli sayılmaz
}

export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new FetchBlockedError("Yalnızca HTTP ve HTTPS adresleri çekilebilir.");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new FetchBlockedError(`Yerel adres engellendi: ${url.hostname}`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      throw new FetchBlockedError(`Özel ağ adresi engellendi: ${host}`);
    }
    return url;
  }

  const resolved = await dns.lookup(host, { all: true }).catch(() => []);
  if (resolved.length === 0) {
    throw new FetchBlockedError(`Adres çözümlenemedi: ${host}`);
  }
  // Tek bir özel IP bile yeterli: DNS rebinding denemesini engeller.
  for (const entry of resolved) {
    if (isPrivateIp(entry.address)) {
      throw new FetchBlockedError(
        `${host} özel bir ağ adresine çözümleniyor (${entry.address}); engellendi.`,
      );
    }
  }
  return url;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export async function fetchPublicPage(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<FetchedPage> {
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Her yönlendirme adımı yeniden doğrulanır.
    const url = await assertPublicUrl(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,*/*" },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new FetchBlockedError("Yönlendirme adresi eksik.");
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new FetchBlockedError(`HTTP ${response.status}: ${url.hostname}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/|json|xml/i.test(contentType)) {
      throw new FetchBlockedError(`Metin olmayan içerik atlandı (${contentType}).`);
    }

    const body = await readCapped(response, MAX_BYTES);
    return {
      url: url.toString(),
      title: extractTitle(body.text) || url.hostname,
      text: htmlToText(body.text),
      truncated: body.truncated,
    };
  }

  throw new FetchBlockedError("Çok fazla yönlendirme.");
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    text += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      await reader.cancel();
      return { text, truncated: true };
    }
  }
  return { text: text + decoder.decode(), truncated: false };
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  return match?.[1] ? decodeEntities(match[1]).trim() : "";
}

/** Kaba HTML → metin. Ajan için gövde metni yeterli; düzen gerekmiyor. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, num: string) =>
      String.fromCodePoint(Number.parseInt(num, 10)),
    )
    // & en sona: önce diğerleri çözülmeli.
    .replace(/&amp;/g, "&");
}
