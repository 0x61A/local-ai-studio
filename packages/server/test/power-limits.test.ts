import { describe, expect, it } from "vitest";
import { buildArgs, resolveResourceLimits } from "../src/engines/llama.js";
import type { LoadPlan } from "../src/hardware/budget.js";

const DUMMY_PLAN: LoadPlan = {
  contextSize: 4096,
  gpuLayers: -1,
  estimatedMb: 4000,
  fits: true,
  reason: "Tamamı GPU'da",
};

describe("Kaynak ve Isınma Kontrolü (Güç Profilleri)", () => {
  it("Maksimum Performans modunda tüm fiziksel çekirdekleri ve 512 ubatch kullanır", () => {
    const limits = resolveResourceLimits({ powerMode: "performance" });
    expect(limits.threads).toBeGreaterThanOrEqual(1);
    expect(limits.ubatchSize).toBe(512);
    expect(limits.gpuOffload).toBe(true);

    const args = buildArgs("/fake/model.gguf", 18080, DUMMY_PLAN, { powerMode: "performance" });
    expect(args).toContain("--threads");
    expect(args).toContain(String(limits.threads));
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("512");
    expect(args).toContain("--n-gpu-layers");
    expect(args).toContain("999");
  });

  it("Dengeli modda çekirdeklerin ~%70'ini ve 256 ubatch kullanır", () => {
    const limits = resolveResourceLimits({ powerMode: "balanced" });
    expect(limits.threads).toBeGreaterThanOrEqual(1);
    expect(limits.ubatchSize).toBe(256);
    expect(limits.gpuOffload).toBe(true);

    const args = buildArgs("/fake/model.gguf", 18080, DUMMY_PLAN, { powerMode: "balanced" });
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("256");
  });

  it("Eko / Sessiz modda çekirdek sayısını ve ubatch'i (128) kısarak ısınmayı önler", () => {
    const limits = resolveResourceLimits({ powerMode: "eco" });
    expect(limits.threads).toBeGreaterThanOrEqual(1);
    expect(limits.threads).toBeLessThanOrEqual(4);
    expect(limits.ubatchSize).toBe(128);

    const args = buildArgs("/fake/model.gguf", 18080, DUMMY_PLAN, { powerMode: "eco" });
    expect(args).toContain("--threads");
    expect(args).toContain(String(limits.threads));
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("128");
  });

  it("Özel modda kullanıcının belirlediği çekirdek ve ubatch değerlerini uygular", () => {
    const limits = resolveResourceLimits({
      powerMode: "custom",
      cpuThreads: 2,
      ubatchSize: 64,
      gpuOffload: false,
    });
    expect(limits.threads).toBe(2);
    expect(limits.ubatchSize).toBe(64);
    expect(limits.gpuOffload).toBe(false);

    const args = buildArgs("/fake/model.gguf", 18080, DUMMY_PLAN, {
      powerMode: "custom",
      cpuThreads: 2,
      ubatchSize: 64,
      gpuOffload: false,
    });
    expect(args).toContain("--threads");
    expect(args).toContain("2");
    expect(args).toContain("--ubatch-size");
    expect(args).toContain("64");
    // GPU kapalı olduğunda 0 katman atanır
    const nglIndex = args.indexOf("--n-gpu-layers");
    expect(args[nglIndex + 1]).toBe("0");
  });
});
