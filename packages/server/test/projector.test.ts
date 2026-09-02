import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATALOG_MODELS, getCatalog } from "../src/models/catalog.js";
import {
  findProjectorFor,
  normalizeModelName,
  normalizeProjectorName,
} from "../src/models/projector.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-proj-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function put(...names: string[]) {
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
}

describe("ad normalleştirme", () => {
  it("nicemleme kuyruğunu atar", () => {
    expect(normalizeModelName("Qwen2-VL-7B-Instruct-Q4_K_M.gguf")).toBe("qwen2-vl-7b-instruct");
    expect(normalizeModelName("Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf")).toBe(
      "llama-3-2-11b-vision-instruct",
    );
    expect(normalizeModelName("MiniCPM-V-2_6-Q4_K_M.gguf")).toBe("minicpm-v-2-6");
  });

  it("projektör işaretlerini ve hassasiyeti atar", () => {
    expect(normalizeProjectorName("mmproj-Qwen2-VL-7B-Instruct-f16.gguf")).toBe(
      "qwen2-vl-7b-instruct",
    );
    expect(normalizeProjectorName("Llama-3.2-11B-Vision-Instruct-mmproj.f16.gguf")).toBe(
      "llama-3-2-11b-vision-instruct",
    );
    expect(normalizeProjectorName("mmproj-MiniCPM-V-2_6-f16.gguf")).toBe("minicpm-v-2-6");
  });
});

describe("projektör eşleştirme", () => {
  it("katalogdaki üç görsel modelin dosyalarını eşleştirir", () => {
    for (const model of CATALOG_MODELS.filter((m) => m.projectorFile)) {
      put(model.recommendedFile, model.projectorFile as string);
      expect(findProjectorFor(dir, model.recommendedFile)).toBe(model.projectorFile);
      fs.rmSync(path.join(dir, model.recommendedFile));
      fs.rmSync(path.join(dir, model.projectorFile as string));
    }
  });

  it("görsel olmayan modele projektör bağlamaz", () => {
    put("Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "mmproj-MiniCPM-V-2_6-f16.gguf");
    expect(findProjectorFor(dir, "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")).toBeNull();
  });

  it("tek mmproj var diye onu seçmez", () => {
    // Yanlış modelin kodlayıcısını bağlamak çöp çıktı üretir ve nedeni
    // hiçbir yerde görünmez; eşleşme yoksa hiç bağlamamak doğrusu.
    put("Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf", "mmproj-Qwen2-VL-7B-Instruct-f16.gguf");
    expect(findProjectorFor(dir, "Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf")).toBeNull();
  });

  it("birden fazla mmproj arasından doğrusunu seçer", () => {
    put(
      "MiniCPM-V-2_6-Q4_K_M.gguf",
      "mmproj-Qwen2-VL-7B-Instruct-f16.gguf",
      "mmproj-MiniCPM-V-2_6-f16.gguf",
    );
    expect(findProjectorFor(dir, "MiniCPM-V-2_6-Q4_K_M.gguf")).toBe(
      "mmproj-MiniCPM-V-2_6-f16.gguf",
    );
  });

  it("olmayan klasörde çökmez", () => {
    expect(findProjectorFor(path.join(dir, "yok"), "a-Q4_K_M.gguf")).toBeNull();
  });
});

describe("katalog projektör alanları", () => {
  it("görsel modellerin hepsinde projektör var", () => {
    for (const model of CATALOG_MODELS.filter((m) => m.category === "vision")) {
      // Projektörsüz bir görsel model sessizce metin modeline dönüşür.
      expect(model.projectorFile, model.id).toBeTruthy();
      expect(model.projectorSizeBytes ?? 0).toBeGreaterThan(100_000_000);
    }
  });

  it("projektör adresi model deposuyla aynı", () => {
    for (const model of getCatalog("tr").filter((m) => m.projectorFile)) {
      expect(model.projectorUrl).toContain(`/${model.repo}/resolve/main/`);
      expect(decodeURIComponent(model.projectorUrl as string)).toContain(
        model.projectorFile as string,
      );
    }
  });

  it("bellek tahmini projektörü de sayar", () => {
    const vision = getCatalog("tr").find((m) => m.id === "minicpm-v-2_6");
    const item = CATALOG_MODELS.find((m) => m.id === "minicpm-v-2_6");
    const modelOnlyMb = Math.round((item!.sizeBytes / (1024 * 1024)) * 1.2);
    expect(vision!.estimatedMb).toBeGreaterThan(modelOnlyMb);
  });
});
