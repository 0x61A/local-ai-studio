import { beforeEach, describe, expect, it } from "vitest";
import {
  planLoad,
  release,
  reserve,
  reservedMb,
  resetReservations,
  type MemoryBudget,
} from "../src/hardware/budget.js";
import type { GgufInfo } from "../src/models/gguf.js";

function model(overrides: Partial<GgufInfo> = {}): GgufInfo {
  return {
    architecture: "llama",
    blockCount: 32,
    embeddingLength: 4096,
    headCount: 32,
    headCountKv: 8,
    trainContextLength: 32768,
    fileSizeBytes: 4 * 1024 * 1024 * 1024, // 4 GB
    quantization: "Q4",
    isEmbedding: false,
    name: "test",
    ...overrides,
  };
}

function budget(freeMb: number): MemoryBudget {
  return { budgetMb: freeMb, usedMb: 0, freeMb, unifiedMemory: true, vramFreeMb: 0 };
}

/** Ayrık kart: sistem belleği ayrı, VRAM ayrı bütçe. */
function discrete(freeMb: number, vramFreeMb: number): MemoryBudget {
  return { budgetMb: freeMb, usedMb: 0, freeMb, unifiedMemory: false, vramFreeMb };
}

beforeEach(() => resetReservations());

describe("ayırmalar", () => {
  it("motorların ayak izini toplar", () => {
    reserve("llama", 4000);
    reserve("whisper", 500);
    expect(reservedMb()).toBe(4500);
  });

  it("serbest bırakınca düşer", () => {
    reserve("llama", 4000);
    release("llama");
    expect(reservedMb()).toBe(0);
  });

  it("aynı motoru iki kez ayırmaz", () => {
    reserve("llama", 4000);
    reserve("llama", 3000);
    expect(reservedMb()).toBe(3000);
  });
});

describe("planLoad", () => {
  it("bol bellekte tam bağlam ve tüm katmanları verir", () => {
    const plan = planLoad(model(), {}, budget(20_000));
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBe(-1);
    expect(plan.contextSize).toBe(32768);
  });

  it("istenen bağlamı eğitim tavanının üstüne çıkarmaz", () => {
    const plan = planLoad(model({ trainContextLength: 8192 }), { contextSize: 131072 }, budget(20_000));
    expect(plan.contextSize).toBe(8192);
  });

  it("dar bellekte bağlamı küçültür ama GPU'da tutar", () => {
    // 4 GB model + 256 MB pay; 6 GB bütçede büyük bağlam sığmaz
    const plan = planLoad(model(), { contextSize: 32768 }, budget(6000));
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBe(-1);
    expect(plan.contextSize).toBeLessThan(32768);
    expect(plan.reason).toContain("düşürüldü");
  });

  it("birleşik bellekte sığmayan modeli bölmeye çalışmaz", () => {
    // Apple Silicon'da GPU ve CPU aynı havuzu kullanır; katman taşımak
    // tek bayt kazandırmaz. Doğru cevap "sığmıyor".
    const plan = planLoad(model(), {}, budget(2500));
    expect(plan.fits).toBe(false);
    expect(plan.reason).toContain("çalıştırılamayacak kadar büyük");
    expect(plan.reason).toContain("nicemlenmiş");
  });

  it("ayrık GPU'da katmanları VRAM'e göre böler", () => {
    // 4 GB model 16 GB RAM'e sığar ama 6 GB VRAM'e bağlamıyla birlikte sığmaz.
    const plan = planLoad(model(), {}, discrete(16_000, 6000));
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBeGreaterThan(0);
    expect(plan.gpuLayers).toBeLessThan(32);
    expect(plan.reason).toContain("katman hızlandırıcıda");
  });

  it("VRAM bolsa ayrık kartta da tüm katmanları verir", () => {
    const plan = planLoad(model(), {}, discrete(32_000, 24_000));
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBe(-1);
  });

  it("VRAM ölçülemediyse katman taşımaz", () => {
    // Ölçemediğimiz bir sınıra model itmek sessiz OOM olurdu.
    const plan = planLoad(model(), {}, discrete(16_000, 0));
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBe(0);
    expect(plan.reason).toContain("işlemcide");
  });

  it("VRAM tek katmana bile yetmiyorsa işlemcide bırakır", () => {
    const plan = planLoad(model(), {}, discrete(16_000, 100));
    expect(plan.fits).toBe(true);
    expect(plan.gpuLayers).toBe(0);
  });

  it("ayrık kartta da sistem belleği tavandır", () => {
    // 60 GB model: VRAM bol olsa bile ağırlıkların kalanı RAM'e sığmıyor.
    const plan = planLoad(model({ fileSizeBytes: 60 * 1024 * 1024 * 1024 }), {}, discrete(4000, 24_000));
    expect(plan.fits).toBe(false);
    expect(plan.reason).toContain("çalıştırılamayacak kadar büyük");
  });

  it("birleşik bellekte hiç sığmıyorsa açıkça söyler", () => {
    const plan = planLoad(model({ fileSizeBytes: 60 * 1024 * 1024 * 1024 }), {}, budget(4000));
    expect(plan.fits).toBe(false);
    expect(plan.reason).toContain("çalıştırılamayacak kadar büyük");
    expect(plan.reason).toContain("GB");
  });

  it("küçük model küçük makinede rahat sığar", () => {
    const small = model({
      fileSizeBytes: 400 * 1024 * 1024,
      blockCount: 24,
      embeddingLength: 896,
      headCount: 14,
      headCountKv: 2,
      trainContextLength: 32768,
    });
    const plan = planLoad(small, {}, budget(8000));
    expect(plan.fits).toBe(true);
    expect(plan.contextSize).toBe(32768);
    expect(plan.gpuLayers).toBe(-1);
  });

  it("her zaman merdivendeki bir bağlam değeri döner", () => {
    for (const free of [1000, 3000, 5000, 8000, 16000, 32000]) {
      const plan = planLoad(model(), {}, budget(free));
      expect(plan.contextSize).toBeGreaterThanOrEqual(2048);
      expect(Number.isInteger(plan.contextSize)).toBe(true);
    }
  });
});
