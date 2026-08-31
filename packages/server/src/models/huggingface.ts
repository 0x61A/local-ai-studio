import { getSecret } from "../security/secrets.js";

/**
 * Hugging Face model arama ve dosya listeleme.
 *
 * Yalnızca tek dosyalık GGUF checkpoint'ler hedeflenir; çok parçalı
 * depolar (`-00001-of-00003.gguf`) tek tıkla yüklenemediği için ayıklanır.
 */

const API = "https://huggingface.co/api";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface HfFile {
  path: string;
  sizeBytes: number;
  /** LFS nesnesinin SHA256'sı; indirme doğrulaması bunu kullanır. */
  sha256: string | null;
  downloadUrl: string;
}

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
  updatedAt: string;
  gated: boolean;
  tags: string[];
}

export interface HfModelDetail extends HfModel {
  files: HfFile[];
  /** Görsel anlama için eşleşen mmproj dosyası. */
  projector: HfFile | null;
}

const cache = new Map<string, { at: number; value: unknown }>();

export async function searchGgufModels(
  query: string,
  limit = 20,
): Promise<HfModel[]> {
  const params = new URLSearchParams({
    search: query.trim(),
    filter: "gguf",
    sort: "downloads",
    direction: "-1",
    limit: String(Math.max(1, Math.min(100, limit))),
  });
  const payload = await cachedJson<Array<Record<string, unknown>>>(
    `${API}/models?${params.toString()}`,
  );
  return payload.map(toModel);
}

export async function getModelDetail(repoId: string): Promise<HfModelDetail> {
  const [info, tree] = await Promise.all([
    cachedJson<Record<string, unknown>>(`${API}/models/${repoId}`),
    cachedJson<Array<Record<string, unknown>>>(
      `${API}/models/${repoId}/tree/main?recursive=true`,
    ),
  ]);

  const all = tree
    .filter((entry) => entry["type"] === "file")
    .map((entry) => toFile(repoId, entry));

  const ggufs = all.filter(
    (file) =>
      file.path.toLowerCase().endsWith(".gguf") &&
      // Çok parçalı depolar tek tıkla yüklenemez.
      !/-\d{5}-of-\d{5}\.gguf$/i.test(file.path) &&
      !isProjector(file.path),
  );

  return {
    ...toModel({ ...info, id: repoId }),
    files: ggufs.sort((a, b) => a.sizeBytes - b.sizeBytes),
    projector: all.find((file) => isProjector(file.path)) ?? null,
  };
}

/**
 * Bellek bütçesine sığan en iyi nicemlemeyi seçer.
 * Sığanların en büyüğü alınır: daha büyük nicemleme = daha iyi kalite.
 */
export function pickBestFit(files: HfFile[], budgetMb: number): HfFile | null {
  if (files.length === 0) return null;
  // Modelin yanında KV önbelleği ve pay için yer bırak.
  const usableBytes = Math.max(0, (budgetMb - 1024) * 1024 * 1024);
  const fitting = files.filter((file) => file.sizeBytes <= usableBytes);
  if (fitting.length > 0) {
    return fitting.reduce((best, file) =>
      file.sizeBytes > best.sizeBytes ? file : best,
    );
  }
  // Hiçbiri sığmıyorsa en küçüğünü öner; kullanıcı yine de görsün.
  return files.reduce((best, file) => (file.sizeBytes < best.sizeBytes ? file : best));
}

/** mmproj dosyaları görsel anlama için ayrı yüklenir, sohbet modeli değildir. */
export function isProjector(filePath: string): boolean {
  return /mmproj|projector/i.test(filePath) && filePath.toLowerCase().endsWith(".gguf");
}

// -- İç yardımcılar -----------------------------------------------------------

function toModel(raw: Record<string, unknown>): HfModel {
  return {
    id: String(raw["id"] ?? raw["modelId"] ?? ""),
    downloads: Number(raw["downloads"] ?? 0),
    likes: Number(raw["likes"] ?? 0),
    updatedAt: String(raw["lastModified"] ?? ""),
    gated: raw["gated"] !== false && raw["gated"] !== undefined,
    tags: Array.isArray(raw["tags"]) ? (raw["tags"] as string[]) : [],
  };
}

function toFile(repoId: string, raw: Record<string, unknown>): HfFile {
  const filePath = String(raw["path"] ?? "");
  const lfs = raw["lfs"] as { oid?: string; size?: number } | undefined;
  return {
    path: filePath,
    sizeBytes: Number(lfs?.size ?? raw["size"] ?? 0),
    sha256: lfs?.oid ?? null,
    downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${filePath
      .split("/")
      .map(encodeURIComponent)
      .join("/")}?download=true`,
  };
}

async function cachedJson<T>(url: string): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value as T;

  // Kapılı depolar için isteğe bağlı HF anahtarı.
  const token = getSecret("huggingface");
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Bu depo erişim izni gerektiriyor. Ayarlardan Hugging Face anahtarı ekleyin."
        : `Hugging Face isteği başarısız (HTTP ${response.status}).`,
    );
  }
  const value = (await response.json()) as T;
  cache.set(url, { at: Date.now(), value });
  return value;
}

export function clearHfCache(): void {
  cache.clear();
}
