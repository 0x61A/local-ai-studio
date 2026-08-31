import type { DatabaseSync } from "node:sqlite";
import { embedTexts, type EmbedSpec } from "./embed.js";
import {
  generation,
  getChunks,
  keywordMatches,
  loadVectors,
  type StoredChunk,
  type VectorSet,
} from "./store.js";

/**
 * Arama.
 *
 * Saf JS iç çarpım: 50 bin parça × 768 boyut = 38 milyon çarpma, düz
 * Float32Array üzerinde milisaniyeler sürer. Yaklaşık komşu indeksi
 * (HNSW vb.) bu ölçekte kazanç değil, native bağımlılık getirir.
 *
 * Anlamsal arama tek başına yetmez: ürün kodu, sürüm numarası, özel ad
 * gibi birebir terimleri kaçırır. FTS sonuçlarıyla sıra tabanlı
 * birleştirme (RRF) yapılır -- iki listenin puanları aynı ölçekte
 * olmadığı için puan toplamak yanlış olurdu.
 */

export interface SearchHit {
  chunk: StoredChunk;
  score: number;
  /** Hangi yolla bulundu; arayüzde gösterilir. */
  matchedBy: "semantic" | "keyword" | "both";
}

export interface SearchOptions {
  topK?: number;
  /** Aday havuzu; her iki listeden bu kadar sonuç alınır. */
  candidates?: number;
  database?: DatabaseSync;
}

/** RRF sabiti; literatürdeki 60 değeri küçük listelerde de dengeli. */
const RRF_K = 60;

const cache = new Map<string, { generation: number; vectors: VectorSet }>();

export function invalidateVectorCache(collectionId?: string): void {
  if (collectionId) cache.delete(collectionId);
  else cache.clear();
}

function vectorsFor(collectionId: string, database?: DatabaseSync): VectorSet {
  const current = generation(collectionId);
  const cached = cache.get(collectionId);
  if (cached && cached.generation === current) return cached.vectors;
  const vectors = loadVectors(collectionId, database);
  cache.set(collectionId, { generation: current, vectors });
  return vectors;
}

export async function searchCollection(
  collectionId: string,
  spec: EmbedSpec,
  query: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const topK = options.topK ?? 6;
  const candidates = options.candidates ?? Math.max(topK * 4, 24);
  const vectors = vectorsFor(collectionId, options.database);

  const [queryVector] = await embedTexts(spec, [query], "query");
  const semantic =
    queryVector && vectors.dimensions === queryVector.length
      ? topMatches(vectors, queryVector, candidates)
      : [];
  const keyword = keywordMatches(collectionId, query, candidates, options.database);

  const fused = fuse(semantic.map((hit) => hit.id), keyword);
  const chunks = getChunks(
    fused.slice(0, topK).map((entry) => entry.id),
    options.database,
  );

  return fused
    .slice(0, topK)
    .map((entry) => {
      const chunk = chunks.get(entry.id);
      return chunk ? { chunk, score: entry.score, matchedBy: entry.matchedBy } : null;
    })
    .filter((hit): hit is SearchHit => hit !== null);
}

/** Vektörler birim uzunlukta saklandığı için iç çarpım = kosinüs. */
export function topMatches(
  vectors: VectorSet,
  query: Float32Array,
  limit: number,
): Array<{ id: string; score: number }> {
  const { data, dimensions, ids } = vectors;
  if (!dimensions || !ids.length) return [];

  const scores: Array<{ id: string; score: number }> = [];
  for (let index = 0; index < ids.length; index += 1) {
    const offset = index * dimensions;
    let dot = 0;
    for (let axis = 0; axis < dimensions; axis += 1) {
      dot += (data[offset + axis] as number) * (query[axis] as number);
    }
    scores.push({ id: ids[index] as string, score: dot });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, limit);
}

/**
 * Reciprocal Rank Fusion: her listede sıraya göre 1/(k+sıra) puanı verilir
 * ve toplanır. Puan ölçekleri (kosinüs vs. bm25) karşılaştırılabilir
 * olmadığı için sıra üzerinden birleştirmek tek doğru yol.
 */
export function fuse(
  semantic: string[],
  keyword: string[],
): Array<{ id: string; score: number; matchedBy: SearchHit["matchedBy"] }> {
  const scores = new Map<string, number>();
  const sources = new Map<string, Set<"semantic" | "keyword">>();

  const add = (ids: string[], source: "semantic" | "keyword") => {
    ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
      const set = sources.get(id) ?? new Set();
      set.add(source);
      sources.set(id, set);
    });
  };
  add(semantic, "semantic");
  add(keyword, "keyword");

  return [...scores.entries()]
    .map(([id, score]) => {
      const found = sources.get(id) as Set<"semantic" | "keyword">;
      return {
        id,
        score,
        matchedBy: (found.size === 2 ? "both" : [...found][0]) as SearchHit["matchedBy"],
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Modele verilecek kaynak bloğu. Numaralandırma zorunlu: model cevabında
 * [1], [2] diye atıf yapabilsin ve kullanıcı hangi sayfadan geldiğini
 * doğrulayabilsin. Atıfsız RAG, uydurmayı kaynaklı gibi gösterir.
 */
export function formatSources(hits: SearchHit[]): string {
  return hits
    .map((hit, index) => {
      const where = [
        hit.chunk.documentName,
        hit.chunk.page > 1 ? `s. ${hit.chunk.page}` : "",
        hit.chunk.heading,
      ]
        .filter(Boolean)
        .join(", ");
      return `[${index + 1}] ${where}\n${hit.chunk.text}`;
    })
    .join("\n\n---\n\n");
}

export interface SourceRef {
  index: number;
  documentId: string;
  documentName: string;
  page: number;
  heading: string;
  snippet: string;
  score: number;
  matchedBy: SearchHit["matchedBy"];
}

export function toSourceRefs(hits: SearchHit[], query = ""): SourceRef[] {
  return hits.map((hit, index) => ({
    index: index + 1,
    documentId: hit.chunk.documentId,
    documentName: hit.chunk.documentName,
    page: hit.chunk.page,
    heading: hit.chunk.heading,
    snippet: excerpt(hit.chunk.text, query),
    score: hit.score,
    matchedBy: hit.matchedBy,
  }));
}

const SNIPPET_CHARS = 320;
/** Eşleşen terimden önce gösterilecek bağlam. */
const SNIPPET_LEAD = 100;

/**
 * Parçanın başını değil, eşleşen yerin çevresini gösterir.
 *
 * Atıf panelinin tek işi kullanıcının "bu kaynak gerçekten bunu diyor mu"
 * sorusunu yanıtlamak. 1800 karakterlik bir parçanın ilk 320 karakteri
 * çoğu zaman aranan cümleyi hiç içermez ve alıntı yanlış görünür.
 */
export function excerpt(text: string, query: string): string {
  if (text.length <= SNIPPET_CHARS) return text;

  const haystack = text.toLocaleLowerCase("tr");
  let at = -1;
  for (const term of query.split(/[^\p{L}\p{N}_.]+/u)) {
    if (term.length < 3) continue;
    const found = haystack.indexOf(term.toLocaleLowerCase("tr"));
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1) return `${text.slice(0, SNIPPET_CHARS)}…`;

  const start = Math.max(0, at - SNIPPET_LEAD);
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
