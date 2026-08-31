import { getSecret, hasSecret } from "../security/secrets.js";
import { extractTitle, htmlToText } from "./fetch.js";

/**
 * Web arama sağlayıcıları.
 *
 * Referans projede tek seçenek vardı: DuckDuckGo HTML'ini regex ile
 * ayrıştırmak. Sayfa düzeni değişince arama tamamen kırılıyordu ve
 * yedek yoktu. Burada anahtar isteyen iki gerçek API de var; anahtar
 * varsa onlar tercih edilir, yoksa kazıma yedeğe düşer.
 */

export type SearchProviderId = "brave" | "tavily" | "duckduckgo";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: SearchProviderId;
}

export interface SearchProviderInfo {
  id: SearchProviderId;
  label: string;
  requiresApiKey: boolean;
  secretName: string;
  keyUrl: string;
  available: boolean;
}

export function listSearchProviders(): SearchProviderInfo[] {
  return [
    {
      id: "brave",
      label: "Brave Search",
      requiresApiKey: true,
      secretName: "brave",
      keyUrl: "https://brave.com/search/api/",
      available: hasSecret("brave"),
    },
    {
      id: "tavily",
      label: "Tavily",
      requiresApiKey: true,
      secretName: "tavily",
      keyUrl: "https://app.tavily.com/home",
      available: hasSecret("tavily"),
    },
    {
      id: "duckduckgo",
      label: "DuckDuckGo (anahtarsız)",
      requiresApiKey: false,
      secretName: "",
      keyUrl: "",
      available: true,
    },
  ];
}

/** Anahtarı olan ilk gerçek API, yoksa kazıma. */
export function pickProvider(preferred?: SearchProviderId): SearchProviderId {
  if (preferred) {
    const info = listSearchProviders().find((entry) => entry.id === preferred);
    if (info?.available) return preferred;
  }
  if (hasSecret("brave")) return "brave";
  if (hasSecret("tavily")) return "tavily";
  return "duckduckgo";
}

export async function search(
  query: string,
  options: { limit?: number; provider?: SearchProviderId; signal?: AbortSignal } = {},
): Promise<{ provider: SearchProviderId; results: SearchResult[] }> {
  const limit = Math.max(1, Math.min(10, options.limit ?? 5));
  const provider = pickProvider(options.provider);

  const results =
    provider === "brave"
      ? await searchBrave(query, limit, options.signal)
      : provider === "tavily"
        ? await searchTavily(query, limit, options.signal)
        : await searchDuckDuckGo(query, limit, options.signal);

  return { provider, results };
}

async function searchBrave(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const key = getSecret("brave");
  if (!key) throw new Error("Brave API anahtarı tanımlı değil.");
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));

  const response = await fetch(url, {
    headers: { accept: "application/json", "x-subscription-token": key },
    signal: signal ?? null,
  });
  if (!response.ok) throw new Error(`Brave araması başarısız (HTTP ${response.status}).`);
  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (payload.web?.results ?? [])
    .filter((item) => item.url)
    .slice(0, limit)
    .map((item) => ({
      title: item.title ?? item.url ?? "",
      url: item.url as string,
      snippet: htmlToText(item.description ?? ""),
      provider: "brave" as const,
    }));
}

async function searchTavily(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const key = getSecret("tavily");
  if (!key) throw new Error("Tavily API anahtarı tanımlı değil.");
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: limit }),
    signal: signal ?? null,
  });
  if (!response.ok) throw new Error(`Tavily araması başarısız (HTTP ${response.status}).`);
  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (payload.results ?? [])
    .filter((item) => item.url)
    .slice(0, limit)
    .map((item) => ({
      title: item.title ?? (item.url as string),
      url: item.url as string,
      snippet: (item.content ?? "").slice(0, 400),
      provider: "tavily" as const,
    }));
}

async function searchDuckDuckGo(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);
  url.searchParams.set("kl", "wt-wt");

  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Apple Silicon) LocalAIStudio/1.0",
      accept: "text/html",
    },
    signal: signal ?? null,
  });
  if (!response.ok) {
    throw new Error(
      `DuckDuckGo araması başarısız (HTTP ${response.status}). ` +
        `Ayarlardan Brave veya Tavily anahtarı eklerseniz kazımaya bağlı kalmazsınız.`,
    );
  }
  return parseDuckDuckGoHtml(await response.text(), limit);
}

/**
 * DuckDuckGo HTML ayrıştırıcı.
 *
 * Kazıma kırılgandır ve bunu saklamıyoruz: hiç sonuç çıkmazsa çağıran
 * tarafa açık hata döner ve kullanıcıya API anahtarı önerilir.
 */
export function parseDuckDuckGoHtml(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorPattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(html)) !== null && results.length < limit) {
    const href = decodeDuckDuckGoUrl(match[1] ?? "");
    const title = htmlToText(match[2] ?? "");
    if (!href || !title || results.some((item) => item.url === href)) continue;

    // Bağlantıdan sonraki parçacığı ara; bulunamazsa boş geç.
    const after = html.slice(anchorPattern.lastIndex, anchorPattern.lastIndex + 2000);
    const snippetMatch = after.match(
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i,
    );
    results.push({
      title,
      url: href,
      snippet: htmlToText(snippetMatch?.[1] ?? "").slice(0, 400),
      provider: "duckduckgo",
    });
  }
  return results;
}

function decodeDuckDuckGoUrl(raw: string): string {
  const href = raw.replace(/&amp;/g, "&");
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    // Sonuçlar /l/?uddg=<hedef> biçiminde yönlendirme bağlantısı olabilir.
    const target = parsed.searchParams.get("uddg");
    if (target) return decodeURIComponent(target);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : "";
  } catch {
    return "";
  }
}

export { extractTitle };
