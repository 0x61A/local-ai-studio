import { estimateMemoryMb, type GgufInfo } from "../models/gguf.js";
import { getAvailableMemoryMb, getGpuInfo, getVramUsedMb } from "./detect.js";

/**
 * Bellek bütçe yöneticisi.
 *
 * Referans projedeki "aynı anda tek ağır motor" kuralının yerini alır.
 * O kural VRAM'i korurdu ama ajan için gereken eşzamanlılığı da engellerdi
 * (sohbet modeli + gömme modeli + TTS aynı anda yüklü olamazdı).
 *
 * Burada motorlar ayak izlerini bildirir; bütçe yeterse birlikte yüklü
 * kalırlar, yetmezse en eski kullanılan tahliye edilir.
 */

/** Sistemin nefes alması için ayrılan pay. */
const SYSTEM_RESERVE_MB = 2048;
/** Masaüstü ve pencere yöneticisi de VRAM tüketir; tamamını isteyemeyiz. */
const VRAM_RESERVE_MB = 512;
/** Bağlam küçültme merdiveni; yukarıdan aşağı denenir. */
const CONTEXT_LADDER = [32768, 16384, 8192, 4096, 2048];

export interface MemoryBudget {
  /** Model yerleştirme için kullanılabilir toplam. */
  budgetMb: number;
  /** Şu an motorların tuttuğu. */
  usedMb: number;
  freeMb: number;
  unifiedMemory: boolean;
  /**
   * Ayrık kartta hızlandırıcıya gerçekten sığacak olan. Birleşik bellekte
   * (Apple Silicon) 0'dır: orada ayrı bir VRAM havuzu yoktur. VRAM'i
   * ölçemediğimiz kartlarda da 0 -- katman bölmek kumar olurdu.
   */
  vramFreeMb: number;
}

export interface LoadPlan {
  contextSize: number;
  /** -1: tüm katmanlar GPU'da. 0: yalnızca CPU. */
  gpuLayers: number;
  estimatedMb: number;
  fits: boolean;
  /** Kullanıcıya gösterilecek açıklama. */
  reason: string;
}

/** Yüklü motorların ayak izini bildiren geri çağrılar. */
const reservations = new Map<string, number>();

export function reserve(engineId: string, footprintMb: number): void {
  reservations.set(engineId, footprintMb);
}

export function release(engineId: string): void {
  reservations.delete(engineId);
}

export function reservedMb(): number {
  let total = 0;
  for (const value of reservations.values()) total += value;
  return total;
}

export function getBudget(): MemoryBudget {
  const gpu = getGpuInfo();
  const unifiedMemory = gpu.vendor === "apple";
  const available = getAvailableMemoryMb();

  // Apple Silicon'da bellek birleşik: Metal'in çalışma kümesi tavanı ile
  // gerçekten boş bellek arasındaki küçük olan bağlayıcıdır.
  const ceiling = unifiedMemory && gpu.vramTotalMb > 0
    ? Math.min(gpu.vramTotalMb, available)
    : available;

  const used = reservedMb();
  const budgetMb = Math.max(0, ceiling - SYSTEM_RESERVE_MB);
  // VRAM'de kendi ayırmalarımızı düşmüyoruz: sürücü zaten yüklü modelleri
  // ölçüyor, iki kez saymak bütçeyi olduğundan dar gösterirdi.
  const vramFreeMb =
    !unifiedMemory && gpu.vramTotalMb > 0
      ? Math.max(0, gpu.vramTotalMb - getVramUsedMb() - VRAM_RESERVE_MB)
      : 0;

  return {
    budgetMb,
    usedMb: used,
    freeMb: Math.max(0, budgetMb - used),
    unifiedMemory,
    vramFreeMb,
  };
}

/**
 * Bir GGUF modeli için bağlam ve katman planı üretir.
 *
 * Sıra: istenen bağlamla dene; sığmazsa bağlam merdiveninden aşağı in.
 * Amaç OOM'a girmeden ÖNCE ne olacağını bilmek -- referans proje OOM'u
 * aldıktan sonra daha küçük bağlamla yeniden deniyordu.
 *
 * Sistem belleği her platformda tavandır: ayrık kartta bile hızlandırıcıya
 * sığmayan katmanlar RAM'de durur. Tavanın altında kalındığında ikinci soru
 * "kaç katman hızlandırıcıya sığar" olur ve bu VRAM'e bakar.
 */
export function planLoad(
  info: GgufInfo,
  requested: { contextSize?: number } = {},
  budget: MemoryBudget = getBudget(),
): LoadPlan {
  const maxContext = info.trainContextLength > 0 ? info.trainContextLength : 8192;
  const ladder = buildLadder(requested.contextSize, maxContext);

  for (const contextSize of ladder) {
    const estimate = estimateMemoryMb(info, contextSize);
    if (estimate.totalMb > budget.freeMb) continue;

    const offload = planOffload(info, estimate, budget);
    const shrunk = contextSize < (ladder[0] ?? contextSize);
    const prefix = shrunk
      ? `Bağlam ${contextSize} belirteçe düşürüldü: bellek bütçesi ${formatMb(budget.freeMb)}.`
      : `Bağlam ${contextSize} belirteç.`;

    return {
      contextSize,
      gpuLayers: offload.gpuLayers,
      estimatedMb: estimate.totalMb,
      fits: true,
      reason: `${prefix} ${offload.reason}`,
    };
  }

  const smallest = ladder[ladder.length - 1] ?? 2048;
  const estimate = estimateMemoryMb(info, smallest);
  return {
    contextSize: smallest,
    gpuLayers: 0,
    estimatedMb: estimate.totalMb,
    fits: false,
    reason:
      `Model bu makinede çalıştırılamayacak kadar büyük: en küçük bağlamda bile ` +
      `~${formatMb(estimate.totalMb)} gerekiyor, ${formatMb(budget.freeMb)} boş. ` +
      `Daha küçük nicemlenmiş bir sürüm deneyin.`,
  };
}

/**
 * Kaç katman hızlandırıcıda kalsın?
 *
 * Üç dünya var ve üçü farklı cevap ister:
 *  - Birleşik bellek (Apple Silicon): GPU ile CPU aynı havuzu kullanır,
 *    katman taşımak tek bayt kazandırmaz. Sığıyorsa hepsi GPU'da.
 *  - Ayrık kart, VRAM ölçülebiliyor: ağırlıklar VRAM'e sığdığı kadar taşınır,
 *    kalanı RAM'de kalır ve işlemcide çalışır.
 *  - Hızlandırıcı yok ya da VRAM ölçülemiyor: 0 katman. Tahmine dayanıp
 *    modeli GPU'ya itmek, ölçemediğimiz bir sınırda sessiz OOM demektir.
 */
function planOffload(
  info: GgufInfo,
  estimate: { modelMb: number; kvCacheMb: number; totalMb: number },
  budget: MemoryBudget,
): { gpuLayers: number; reason: string } {
  if (budget.unifiedMemory) {
    return { gpuLayers: -1, reason: "Tüm katmanlar hızlandırıcıda." };
  }
  if (budget.vramFreeMb <= 0) {
    return {
      gpuLayers: 0,
      reason: "Hızlandırıcı bulunamadı; model işlemcide çalışacak (yavaş).",
    };
  }

  if (estimate.totalMb <= budget.vramFreeMb) {
    return {
      gpuLayers: -1,
      reason: `Tüm katmanlar hızlandırıcıda (${formatMb(budget.vramFreeMb)} VRAM boş).`,
    };
  }

  // Katman başına maliyet: ağırlık payı + o katmanın KV önbelleği. KV yalnızca
  // hızlandırıcıdaki katmanlar için VRAM'de durur, o yüzden katmana bölünür.
  const layers = info.blockCount > 0 ? info.blockCount : 32;
  const perLayerMb = Math.max(1, (estimate.modelMb + estimate.kvCacheMb) / layers);
  const affordable = Math.max(
    0,
    Math.min(layers, Math.floor(budget.vramFreeMb / perLayerMb)),
  );

  if (affordable === 0) {
    return {
      gpuLayers: 0,
      reason: `VRAM (${formatMb(budget.vramFreeMb)} boş) tek katmana yetmiyor; model işlemcide çalışacak (yavaş).`,
    };
  }
  return {
    gpuLayers: affordable,
    reason: `${affordable}/${layers} katman hızlandırıcıda, kalanı işlemcide (${formatMb(budget.vramFreeMb)} VRAM boş).`,
  };
}

function buildLadder(requested: number | undefined, maxContext: number): number[] {
  const cap = requested && requested > 0 ? Math.min(requested, maxContext) : maxContext;
  const ladder = [cap, ...CONTEXT_LADDER.filter((value) => value < cap)];
  return [...new Set(ladder)].sort((a, b) => b - a);
}

function formatMb(megabytes: number): string {
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${megabytes} MB`;
}

/** Testler için: ayırmaları temizler. */
export function resetReservations(): void {
  reservations.clear();
}
