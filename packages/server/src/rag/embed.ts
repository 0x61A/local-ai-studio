import { embeddingBaseUrl } from "../engines/embedding.js";
import { fetchEmbeddings, getProvider } from "../providers/registry.js";
import { ProviderError, type ProviderId } from "../providers/types.js";

/**
 * Gömme üretimi.
 *
 * Yerel sağlayıcı sohbet motorunu değil, ayrı gömme motorunu kullanır:
 * sohbet motoru havuzlama kipinde olmadığı için oradan gelen vektörler
 * anlamsız olurdu.
 */

export interface EmbedSpec {
  provider: ProviderId;
  model: string;
}

/** Yerel motorda yığın küçük tutulur; bulutta istek başına maliyet baskın. */
const LOCAL_BATCH = 8;
const CLOUD_BATCH = 64;

export async function embedTexts(
  spec: EmbedSpec,
  texts: string[],
  role: "document" | "query" = "document",
): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const prepared = texts.map((text) => withPrefix(spec.model, text, role));
  const size = spec.provider === "llamacpp" ? LOCAL_BATCH : CLOUD_BATCH;
  const out: Float32Array[] = [];

  for (let at = 0; at < prepared.length; at += size) {
    const batch = prepared.slice(at, at + size);
    const vectors = await embedBatch(spec, batch);
    if (vectors.length !== batch.length) {
      throw new ProviderError(
        `Gömme sağlayıcısı ${batch.length} metin için ${vectors.length} vektör döndürdü.`,
        false,
      );
    }
    for (const vector of vectors) {
      if (vector.length === 0) {
        throw new ProviderError("Gömme sağlayıcısı boş vektör döndürdü.", false);
      }
      out.push(normalize(vector));
    }
  }

  const dimensions = (out[0] as Float32Array).length;
  if (out.some((vector) => vector.length !== dimensions)) {
    throw new ProviderError(
      "Gömme boyutları tutarsız; model yükleme sırasında değişmiş olabilir.",
      false,
    );
  }
  return out;
}

async function embedBatch(spec: EmbedSpec, texts: string[]): Promise<Float32Array[]> {
  if (spec.provider === "llamacpp") {
    const base = embeddingBaseUrl();
    if (!base) {
      throw new ProviderError(
        "Gömme motoru çalışmıyor. Bilgi tabanı sekmesinden bir gömme modeli başlatın.",
        false,
      );
    }
    return fetchEmbeddings({ baseUrl: base }, texts, spec.model);
  }

  const provider = getProvider(spec.provider);
  if (!provider.embed) {
    throw new ProviderError(`${provider.label} gömme üretmiyor.`, false);
  }
  return provider.embed(texts, spec.model);
}

/**
 * Kosinüs benzerliği yerine iç çarpım kullanabilmek için vektörler
 * yazılmadan önce birim uzunluğa getirilir. Arama sırasında her sorguda
 * norm hesaplamak 50 bin parçada boşa iştir.
 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  if (length === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    out[index] = (vector[index] as number) / length;
  }
  return out;
}

/**
 * Bazı gömme modelleri sorguyla belgeyi ayırt etmek için önek bekler.
 * Öneki atlamak bu modellerde isabeti gözle görülür düşürür; model adına
 * bakmak, kullanıcıya bir alan daha doldurtmaktan iyi.
 */
export function withPrefix(
  model: string,
  text: string,
  role: "document" | "query",
): string {
  const name = model.toLowerCase();
  if (name.includes("nomic-embed")) {
    return `${role === "query" ? "search_query" : "search_document"}: ${text}`;
  }
  if (/(^|[-_/])(e5|multilingual-e5)/.test(name)) {
    return `${role === "query" ? "query" : "passage"}: ${text}`;
  }
  return text;
}
