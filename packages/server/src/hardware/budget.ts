import { estimateMemoryMb, type GgufInfo } from "../models/gguf.js";
import { getAvailableMemoryMb, getGpuInfo } from "./detect.js";

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
/** Bağlam küçültme merdiveni; yukarıdan aşağı denenir. */
const CONTEXT_LADDER = [32768, 16384, 8192, 4096, 2048];

export interface MemoryBudget {
  /** Model yerleştirme için kullanılabilir toplam. */
  budgetMb: number;
  /** Şu an motorların tuttuğu. */
  usedMb: number;
  freeMb: number;
  unifiedMemory: boolean;
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
  return {
    budgetMb,
    usedMb: used,
    freeMb: Math.max(0, budgetMb - used),
    unifiedMemory,
  };
}

/**
 * Bir GGUF modeli için bağlam ve katman planı üretir.
 *
 * Sıra: istenen bağlamla dene; sığmazsa bağlam merdiveninden aşağı in.
 * Amaç OOM'a girmeden ÖNCE ne olacağını bilmek -- referans proje OOM'u
 * aldıktan sonra daha küçük bağlamla yeniden deniyordu.
 *
 * Katman bölme yalnızca ayrık GPU'da anlamlıdır. Apple Silicon'da bellek
 * birleşiktir: "katmanı CPU'ya taşımak" aynı havuzdan okumaktır, tek bayt
 * kazandırmaz. Bu yüzden birleşik bellekte sığmayan model sığmıyordur.
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
    if (estimate.totalMb <= budget.freeMb) {
      const shrunk = contextSize < (ladder[0] ?? contextSize);
      return {
        contextSize,
        gpuLayers: -1,
        estimatedMb: estimate.totalMb,
        fits: true,
        reason: shrunk
          ? `Bağlam ${contextSize} belirteçe düşürüldü: bellek bütçesi ${formatMb(budget.freeMb)}.`
          : `Tüm katmanlar hızlandırıcıda, bağlam ${contextSize} belirteç.`,
      };
    }
  }

  const smallest = ladder[ladder.length - 1] ?? 2048;
  const estimate = estimateMemoryMb(info, smallest);

  if (budget.unifiedMemory) {
    // Birleşik bellek: bölmenin faydası yok, dürüst cevap "sığmıyor".
    return {
      contextSize: smallest,
      gpuLayers: -1,
      estimatedMb: estimate.totalMb,
      fits: false,
      reason:
        `Model bu makinede çalıştırılamayacak kadar büyük: en küçük bağlamda bile ` +
        `~${formatMb(estimate.totalMb)} gerekiyor, ${formatMb(budget.freeMb)} boş. ` +
        `Daha küçük nicemlenmiş bir sürüm deneyin.`,
    };
  }

  // Ayrık GPU: ağırlıkların bir kısmı VRAM'de, kalanı sistem belleğinde
  // durabilir. Faz 6'da gerçek VRAM/RAM ayrımı geldiğinde bu dal gerçek
  // iki ayrı bütçeyle çalışacak.
  const layers = info.blockCount > 0 ? info.blockCount : 32;
  const perLayerMb = estimate.modelMb / layers;
  const affordable = Math.max(
    0,
    Math.floor((budget.freeMb - estimate.kvCacheMb - 256) / Math.max(1, perLayerMb)),
  );
  // Katmanların yarısından azı hızlandırıcıya sığıyorsa kazanç gürültüde
  // kalır; kullanıcıya "çalışır" demek yanıltıcı olur.
  const worthwhile = affordable >= Math.ceil(layers / 4);

  return {
    contextSize: smallest,
    gpuLayers: Math.min(layers, affordable),
    estimatedMb: estimate.totalMb,
    fits: worthwhile,
    reason: worthwhile
      ? `Model bütçeye sığmıyor: ${affordable}/${layers} katman hızlandırıcıda, kalanı işlemcide (yavaş).`
      : `Model bu makine için fazla büyük: ~${formatMb(estimate.totalMb)} gerekiyor, ` +
        `${formatMb(budget.freeMb)} boş. Yalnızca ${affordable}/${layers} katman ` +
        `hızlandırıcıya sığıyor; kullanılabilir hız vermez.`,
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
