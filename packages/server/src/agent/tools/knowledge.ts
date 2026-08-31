import { z } from "zod";
import { formatSources, searchCollection } from "../../rag/search.js";
import { listCollections, type Collection } from "../../rag/store.js";
import { defineTool, type Tool, type ToolResult } from "../types.js";

/**
 * Bilgi tabanı araması ajana açılır.
 *
 * Koleksiyon adı çalışma anında çözülür; şemaya gömülmez. Şemaya gömmek,
 * kullanıcı yeni koleksiyon açtığında araç tanımının bayatlaması demekti.
 */

export const knowledgeSearch: Tool<{ query: string; collection?: string; topK?: number }> =
  defineTool({
    name: "knowledge_search",
    description:
      "Kullanıcının yüklediği belgelerde (bilgi tabanı) arama yapar. Belgelerde geçen " +
      "bir bilgi sorulduğunda tahmin etmek yerine bunu kullan. Sonuçlar kaynak " +
      "numarası, belge adı ve sayfa ile döner; cevabında [1] biçiminde atıf yap.",
    risk: "read",
    schema: z.object({
      query: z.string().min(1).max(1000).describe("Aranacak soru ya da anahtar ifade"),
      collection: z
        .string()
        .max(200)
        .optional()
        .describe("Koleksiyon adı; birden fazla koleksiyon varsa gerekli"),
      topK: z.number().int().min(1).max(10).optional().describe("Kaç kaynak döneceği"),
    }),
    async run(input): Promise<ToolResult> {
      const collections = listCollections();
      if (!collections.length) {
        return {
          content: "Bilgi tabanı boş. Kullanıcı henüz belge yüklememiş.",
          isError: true,
        };
      }

      const collection = resolveCollection(collections, input.collection);
      if (!collection) {
        return {
          content:
            `Koleksiyon seçilmedi. Mevcut koleksiyonlar: ` +
            collections.map((entry) => entry.name).join(", "),
          isError: true,
        };
      }
      if (collection.chunkCount === 0) {
        return {
          content: `"${collection.name}" koleksiyonunda indekslenmiş belge yok.`,
          isError: true,
        };
      }

      const hits = await searchCollection(
        collection.id,
        {
          provider: collection.embedProvider as never,
          model: collection.embedModel,
        },
        input.query,
        input.topK ? { topK: input.topK } : {},
      );
      if (!hits.length) {
        return { content: `"${input.query}" için bilgi tabanında eşleşme yok.` };
      }

      return {
        content: formatSources(hits),
        detail: {
          collection: collection.name,
          sources: hits.map((hit, index) => ({
            index: index + 1,
            document: hit.chunk.documentName,
            page: hit.chunk.page,
          })),
        },
      };
    },
  });

/**
 * Koleksiyon adını çözer.
 *
 * Tek koleksiyon varsa ad ne gelirse gelsin o seçilir: modeller bu alanı
 * uydurmaya eğilimli ("kullanicinin_belgeleri") ve belirsizlik yokken
 * uydurma bir ad yüzünden aramayı reddetmek kullanıcıya cevapsızlık
 * olarak döner. Belirsizlik ancak birden fazla koleksiyonda gerçektir.
 */
export function resolveCollection(
  collections: Collection[],
  wanted: string | undefined,
): Collection | null {
  if (collections.length === 1) return collections[0] as Collection;
  if (!wanted) return null;
  const needle = wanted.trim().toLocaleLowerCase("tr");
  return (
    collections.find((entry) => entry.id === wanted) ??
    collections.find((entry) => entry.name.toLocaleLowerCase("tr") === needle) ??
    collections.find((entry) => entry.name.toLocaleLowerCase("tr").includes(needle)) ??
    null
  );
}

export const knowledgeTools = [knowledgeSearch];
