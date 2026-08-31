import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/store/db.js";
import { buildSdArgs, estimateFootprintMb } from "../src/engines/sd.js";
import { toWire } from "../src/images/client.js";
import { readParameter, readPng, readSeed } from "../src/images/png.js";
import {
  deleteImage,
  insertImage,
  listImages,
  searchImages,
  setFavorite,
} from "../src/images/store.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

let database: DatabaseSync;
beforeEach(() => {
  database = open(":memory:");
});
afterEach(() => {
  database.close();
});

// -- PNG üst verisi -----------------------------------------------------------

describe("PNG okuyucu", () => {
  // stable-diffusion.cpp'nin gerçekten ürettiği bir görselin başlığı.
  const bytes = () => fs.readFileSync(path.join(FIXTURES, "uretim.png"));

  it("boyutu IHDR'den okur", () => {
    const info = readPng(bytes());
    expect(info.width).toBe(512);
    expect(info.height).toBe(512);
  });

  it("motorun gömdüğü parametreleri bulur", () => {
    const info = readPng(bytes());
    const parameters = info.text.get("parameters");
    expect(parameters).toContain("vintage bicycle");
    expect(readParameter(parameters as string, "Sampler")).toBe("euler_a");
    expect(readParameter(parameters as string, "Steps")).toBe("20");
  });

  it("gerçek tohumu görselden okur", () => {
    // Tohum -1 gönderildiğinde gerçek değeri yalnızca motor bilir;
    // yeniden üretim bu okumaya bağlı.
    expect(readSeed(readPng(bytes()))).toBe(42);
  });

  it("PNG olmayan veriyi sessizce boş döner", () => {
    const info = readPng(Buffer.from("bu bir png degil"));
    expect(info.width).toBe(0);
    expect(info.text.size).toBe(0);
  });

  it("kesik dosyada döngüye girmez", () => {
    const truncated = bytes().subarray(0, 40);
    expect(() => readPng(truncated)).not.toThrow();
  });

  it("olmayan alanı null döner", () => {
    expect(readParameter("Steps: 20, Seed: 7", "Sampler")).toBeNull();
  });
});

// -- İstek gövdesi ------------------------------------------------------------

describe("sd-server istek gövdesi", () => {
  const base = {
    prompt: "bir kedi",
    width: 512,
    height: 512,
    seed: -1,
    batchCount: 1,
    sampling: { steps: 20, cfgScale: 7 },
  };

  it("belirtilmeyen örnekleme alanlarını göndermez", () => {
    // Sunucu model ailesine göre kendi varsayılanını uygular; burada
    // tahmin yürütmek yanlış değer göndermek olurdu.
    const body = toWire(base) as { sample_params: Record<string, unknown> };
    expect(body.sample_params).not.toHaveProperty("sample_method");
    expect(body.sample_params).not.toHaveProperty("scheduler");
    expect(body.sample_params["sample_steps"]).toBe(20);
  });

  it("örnekleyici verilince gönderir", () => {
    const body = toWire({
      ...base,
      sampling: { steps: 20, cfgScale: 7, sampleMethod: "dpm++2m", scheduler: "karras" },
    }) as { sample_params: Record<string, unknown> };
    expect(body.sample_params["sample_method"]).toBe("dpm++2m");
    expect(body.sample_params["scheduler"]).toBe("karras");
  });

  it("hires kapalıysa alanı hiç eklemez", () => {
    expect(toWire({ ...base, hires: { enabled: false } })).not.toHaveProperty("hires");
  });

  it("hires açıkken varsayılanlarla doldurur", () => {
    const body = toWire({ ...base, hires: { enabled: true } }) as {
      hires: Record<string, unknown>;
    };
    expect(body.hires["upscaler"]).toBe("Latent");
    expect(body.hires["scale"]).toBe(2);
  });

  it("başlangıç görseli olmadan strength göndermez", () => {
    expect(toWire(base)).not.toHaveProperty("strength");
  });

  it("img2img'de görsel ve strength birlikte gider", () => {
    const body = toWire({ ...base, initImage: "AAAA", strength: 0.4 });
    expect(body["init_image"]).toBe("AAAA");
    expect(body["strength"]).toBe(0.4);
  });
});

// -- Motor --------------------------------------------------------------------

describe("görsel motoru", () => {
  it("ayak izini dosya boyutu üstüne çalışma belleğiyle tahmin eder", () => {
    // 1 GB'lık model, ara tensörler için sabit paya eklenir.
    expect(estimateFootprintMb(1024 * 1024 * 1024)).toBe(1024 + 900);
  });

  it("adreste yalnızca loopback dinler", () => {
    const args = buildSdArgs("/tmp/model.gguf", 18100);
    expect(args).toContain("--listen-ip");
    expect(args[args.indexOf("--listen-ip") + 1]).toBe("127.0.0.1");
    expect(args[args.indexOf("--listen-port") + 1]).toBe("18100");
  });

  it("difüzyonda flash attention açar", () => {
    expect(buildSdArgs("/tmp/model.gguf", 1)).toContain("--diffusion-fa");
  });
});

// -- Galeri -------------------------------------------------------------------

describe("galeri", () => {
  const seed = (prompt: string, favorite = false) => {
    const image = insertImage(
      {
        filename: `${prompt}.png`,
        prompt,
        negativePrompt: "",
        model: "sd-v1-5",
        sampler: "euler_a",
        scheduler: "",
        steps: 20,
        cfgScale: 7,
        seed: 42,
        width: 512,
        height: 512,
        source: "txt2img",
        parentId: null,
        hires: false,
        ms: 1000,
      },
      database,
    );
    if (favorite) setFavorite(image.id, true, database);
    return image;
  };

  it("kaydedip en yeniden eskiye listeler", () => {
    seed("kirmizi bisiklet");
    seed("deniz feneri");
    const images = listImages({}, database);
    expect(images.length).toBe(2);
    expect(images[0]?.prompt).toBe("deniz feneri");
  });

  it("istemde tam metin araması yapar", () => {
    seed("kirmizi bisiklet tas duvar");
    seed("deniz feneri");
    const hits = searchImages("bisiklet", 10, database);
    expect(hits.length).toBe(1);
    expect(hits[0]?.prompt).toContain("bisiklet");
  });

  it("arama girdisini FTS sözdizimi olarak yorumlamaz", () => {
    seed("kirmizi bisiklet");
    expect(() => searchImages('bisiklet" OR NEAR(', 10, database)).not.toThrow();
  });

  it("favorileri süzer", () => {
    seed("bir");
    seed("iki", true);
    const favorites = listImages({ favoritesOnly: true }, database);
    expect(favorites.length).toBe(1);
    expect(favorites[0]?.prompt).toBe("iki");
  });

  it("silince kaydı ve dosya adını geri verir", () => {
    const image = seed("silinecek");
    const removed = deleteImage(image.id, database);
    // Çağıran taraf dosyayı da silebilsin diye kayıt geri döner.
    expect(removed?.filename).toBe("silinecek.png");
    expect(listImages({}, database).length).toBe(0);
  });

  it("türetilmiş görselde ebeveyn bağını tutar", () => {
    const parent = seed("kaynak");
    const child = insertImage(
      {
        filename: "child.png", prompt: "turev", negativePrompt: "", model: "sd",
        sampler: "", scheduler: "", steps: 20, cfgScale: 7, seed: 1,
        width: 512, height: 512, source: "img2img", parentId: parent.id,
        hires: false, ms: 10,
      },
      database,
    );
    expect(child.parentId).toBe(parent.id);
  });
});
