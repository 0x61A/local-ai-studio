import { describe, expect, it } from "vitest";
import { CATALOG_MODELS, getCatalog } from "../src/models/catalog.js";
import { assertAllowedUrl } from "../src/models/download.js";

describe("LLM Model Kataloğu", () => {
  it("zengin model çeşitliliği içerir", () => {
    expect(CATALOG_MODELS.length).toBeGreaterThanOrEqual(20);
  });

  it("tüm ana kategorileri kapsar", () => {
    const categories = new Set(CATALOG_MODELS.map((m) => m.category));
    expect(categories.has("popular")).toBe(true);
    expect(categories.has("reasoning")).toBe(true);
    expect(categories.has("coding")).toBe(true);
    expect(categories.has("lightweight")).toBe(true);
    expect(categories.has("large")).toBe(true);
    expect(categories.has("vision")).toBe(true);
    expect(categories.has("embedding")).toBe(true);
  });

  it("tüm indirme URL'leri beyaz listede ve geçerli HTTPS adresidir", () => {
    for (const model of CATALOG_MODELS) {
      expect(() => assertAllowedUrl(model.downloadUrl)).not.toThrow();
      expect(model.downloadUrl).toMatch(/^https:\/\/huggingface\.co\//);
      expect(model.recommendedFile).toMatch(/\.gguf$/i);
      expect(model.sizeBytes).toBeGreaterThan(50_000_000);
      expect(model.contextLength).toBeGreaterThanOrEqual(512);
    }
  });

  it("parcali (sharded) GGUF dosyasi gostermez", () => {
    // Indirici tek dosya cekiyor. Qwen'in resmi GGUF depolari dosyalari
    // "-00001-of-00002" seklinde boler; boyle bir dosyaya isaret etmek
    // indirmeyi calisir gosterip yuklenemez bir model birakirdi.
    for (const model of CATALOG_MODELS) {
      expect(model.recommendedFile).not.toMatch(/-\d{5}-of-\d{5}\.gguf$/i);
    }
  });

  it("indirme adresi depo ve dosya adiyla tutarli", () => {
    // Elle yazilan katalogda en sik hata: repo degistirilip downloadUrl
    // eski depoda kalmasi. 404 ancak kullanici indirmeye basinca gorunurdu.
    for (const model of CATALOG_MODELS) {
      expect(model.downloadUrl).toContain(`/${model.repo}/resolve/main/`);
      expect(decodeURIComponent(model.downloadUrl)).toContain(model.recommendedFile);
    }
  });

  it("Türkçe ve İngilizce açıklamalar ve etiketler eksiksizdir", () => {
    for (const model of CATALOG_MODELS) {
      expect(model.descriptionTr.trim().length).toBeGreaterThan(10);
      expect(model.descriptionEn.trim().length).toBeGreaterThan(10);
      expect(model.tagsTr.length).toBeGreaterThan(0);
      expect(model.tagsEn.length).toBeGreaterThan(0);
      expect(model.parameters.trim().length).toBeGreaterThan(0);
    }
  });

  it("bütçeye göre uyumluluk durumunu doğru hesaplar", () => {
    // 4 GB bellekli dar bütçe
    const tight = getCatalog("tr", 4096);
    const smallModel = tight.find((m) => m.id === "llama-3.2-1b-instruct");
    const largeModel = tight.find((m) => m.id === "qwen2.5-32b-instruct");

    expect(smallModel?.fits).toBe(true);
    expect(smallModel?.fitsReason).toContain("akıcı çalışır");
    expect(largeModel?.fits).toBe(false);
    expect(largeModel?.fitsReason).toContain("Yüksek bellek");

    // İngilizce dil desteği
    const enCatalog = getCatalog("en", 4096);
    const enSmall = enCatalog.find((m) => m.id === "llama-3.2-1b-instruct");
    expect(enSmall?.fitsReason).toContain("Runs smoothly");
  });
});
