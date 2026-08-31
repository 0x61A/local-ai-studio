import { z } from "zod";
import { fetchPublicPage, FetchBlockedError } from "../../search/fetch.js";
import { search } from "../../search/providers.js";
import { defineTool, type Tool, type ToolResult } from "../types.js";

/**
 * Web araçları. İkisi de `read` riskinde: dış dünyayı okurlar, kullanıcının
 * makinesinde bir şey değiştirmezler. Çektikleri içerik güvenilmezdir ve
 * modele öyle etiketlenerek verilir.
 */

const MAX_PAGE_CHARS = 8000;

export const webSearch: Tool<{ query: string; limit?: number }> = defineTool({
  name: "web_search",
  description:
    "Web'de arama yapar ve başlık, adres, özet listesi döner. Güncel bilgi gerektiğinde kullan.",
  risk: "read",
  schema: z.object({
    query: z.string().min(1).max(400).describe("Arama sorgusu"),
    limit: z.number().int().min(1).max(10).optional().describe("Sonuç sayısı"),
  }),
  async run(input, context): Promise<ToolResult> {
    try {
      const { provider, results } = await search(input.query, {
        limit: input.limit ?? 5,
        signal: context.signal,
      });
      if (results.length === 0) {
        return {
          content:
            `"${input.query}" için sonuç bulunamadı. ` +
            `(Sağlayıcı: ${provider}. Kazıma kırılmış olabilir; Ayarlar'dan Brave ` +
            `veya Tavily anahtarı eklemek daha güvenilir olur.)`,
          isError: true,
        };
      }
      const lines = results.map(
        (result, index) =>
          `[${index + 1}] ${result.title}\n    ${result.url}\n    ${result.snippet}`,
      );
      return {
        content: `Arama sonuçları (${provider}):\n\n${lines.join("\n\n")}`,
        detail: { provider, results },
      };
    } catch (err) {
      return { content: `Arama başarısız: ${(err as Error).message}`, isError: true };
    }
  },
});

export const fetchUrl: Tool<{ url: string }> = defineTool({
  name: "fetch_url",
  description:
    "Bir web sayfasının metin içeriğini çeker. Arama sonucundaki bir adresi okumak için kullan.",
  risk: "read",
  schema: z.object({ url: z.string().url().describe("Çekilecek tam adres") }),
  async run(input, context): Promise<ToolResult> {
    try {
      const page = await fetchPublicPage(input.url, context.signal);
      const text = page.text.slice(0, MAX_PAGE_CHARS);
      const cut = page.text.length > MAX_PAGE_CHARS || page.truncated;
      return {
        // İçerik dış kaynaktan geliyor; modele güvenilmez olduğu söylenir.
        content:
          `Kaynak: ${page.url}\nBaşlık: ${page.title}\n` +
          `--- güvenilmez dış içerik başlangıcı ---\n${text}` +
          `${cut ? "\n… (kesildi)" : ""}\n--- güvenilmez dış içerik sonu ---`,
        detail: { url: page.url, title: page.title, truncated: cut },
      };
    } catch (err) {
      const message =
        err instanceof FetchBlockedError
          ? err.message
          : `Sayfa çekilemedi: ${(err as Error).message}`;
      return { content: message, isError: true };
    }
  },
});

export const webTools = [webSearch, fetchUrl];
