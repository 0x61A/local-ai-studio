import { describe, expect, it } from "vitest";
import { CATALOG_MODELS, findCatalogModel, getCatalog } from "../src/models/catalog.js";

describe("LLM Model Kataloğu", () => {
  it("zengin model çeşitliliği içerir", () => {
    expect(CATALOG_MODELS.length).toBeGreaterThanOrEqual(20);
  });

  it("tüm ana kategorileri kapsar", () => {
    const categories = new Set(CATALOG_MODELS.map((m) => m.category));
    for (const c of ["popular","reasoning","coding","lightweight","large","vision","embedding"]) {
      expect(categories.has(c as never), c).toBe(true);
    }
  });

  it("dosya adı ya da indirme adresi tutmaz", () => {
    // Elle yazilan dosya adlari curuyor: 33 girdinin 9'u bir noktada 404
    // veriyordu ve bunu ancak kullanici indirmeye basinca ogreniyorduk.
    // Sabit olan tek sey depo kimligi; dosya indirme aninda cozuluyor.
    const source = JSON.stringify(CATALOG_MODELS);
    expect(source).not.toContain(".gguf");
    expect(source).not.toContain("huggingface.co");
  });

  it("her girdide depo kimliği ve nicemleme tercihi var", () => {
    for (const model of CATALOG_MODELS) {
      expect(model.repo, model.id).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(model.preferredQuant, model.id).toMatch(/^(IQ|Q)\d/);
      expect(model.approxSizeBytes).toBeGreaterThan(50_000_000);
      expect(model.contextLength).toBeGreaterThanOrEqual(512);
    }
  });

  it("kimlikler benzersiz", () => {
    const ids = CATALOG_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("görsel modeller projektör istediğini bildirir", () => {
    // Projektorsuz bir gorsel model sessizce metin modeline donusur.
    for (const model of CATALOG_MODELS.filter((m) => m.category === "vision")) {
      expect(model.needsProjector, model.id).toBe(true);
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
    const tight = getCatalog("tr", 4096);
    expect(tight.find((m) => m.id === "llama-3.2-1b-instruct")?.fits).toBe(true);
    expect(tight.find((m) => m.id === "qwen2.5-32b-instruct")?.fits).toBe(false);
    expect(getCatalog("en", 4096).find((m) => m.id === "llama-3.2-1b-instruct")?.fitsReason)
      .toContain("Runs smoothly");
  });

  it("görsel modelin bellek tahmini projektörü de sayar", () => {
    const item = CATALOG_MODELS.find((m) => m.id === "minicpm-v-2_6")!;
    const shown = getCatalog("tr").find((m) => m.id === "minicpm-v-2_6")!;
    const modelOnlyMb = Math.round((item.approxSizeBytes / (1024 * 1024)) * 1.2);
    expect(shown.estimatedMb).toBeGreaterThan(modelOnlyMb);
  });

  it("findCatalogModel bilinmeyen kimlikte null döner", () => {
    expect(findCatalogModel("yok-boyle-bir-sey")).toBeNull();
    expect(findCatalogModel("minicpm-v-2_6")?.repo).toBeTruthy();
  });
});
