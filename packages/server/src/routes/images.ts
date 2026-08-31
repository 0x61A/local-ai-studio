import fs from "node:fs";
import fsp from "node:fs/promises";
import { z } from "zod";
import { IMAGE_MODELS_DIR, OUTPUTS_DIR } from "../config.js";
import {
  listImageModels,
  loadedImageModel,
  sdBaseUrl,
  sdStatus,
  startSd,
  stopSd,
} from "../engines/sd.js";
import { getBudget } from "../hardware/budget.js";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import { SdError, capabilities } from "../images/client.js";
import {
  cancelJob,
  clearFinishedImageJobs,
  imageJobs,
  startGeneration,
} from "../images/generate.js";
import {
  deleteImage,
  getImage,
  listImages,
  searchImages,
  setFavorite,
} from "../images/store.js";
import { resolveInside } from "../security/paths.js";

/** Görsel üretimi ve galeri uçları. */

const GenerateBody = z.object({
  prompt: z.string().min(1).max(4000),
  negativePrompt: z.string().max(4000).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(-1).max(4294967295).optional(),
  batchCount: z.number().int().min(1).max(8).optional(),
  sampler: z.string().max(60).optional(),
  scheduler: z.string().max(60).optional(),
  clipSkip: z.number().int().min(-1).max(12).optional(),
  hires: z
    .object({
      enabled: z.boolean(),
      upscaler: z.string().max(60).optional(),
      scale: z.number().min(1).max(4).optional(),
      steps: z.number().int().min(0).max(150).optional(),
      denoisingStrength: z.number().min(0).max(1).optional(),
    })
    .optional(),
  /** img2img: galerideki bir görselden devam. */
  initImageId: z.string().uuid().optional(),
  strength: z.number().min(0).max(1).optional(),
});

export function registerImageRoutes(router: Router): void {
  router.get("/api/images", {}, async () => ({
    engine: { ...sdStatus(), ready: sdBaseUrl() !== null },
    model: loadedImageModel(),
    models: listImageModels(),
    modelsDir: IMAGE_MODELS_DIR,
    budget: getBudget(),
    jobs: imageJobs(),
    capabilities: sdBaseUrl() ? await capabilities().catch(() => null) : null,
  }));

  router.post(
    "/api/images/engine/load",
    { body: z.object({ filename: z.string().min(1).max(255) }) },
    async ({ body }) => {
      try {
        return { engine: await startSd(body.filename) };
      } catch (err) {
        throw HttpError.badRequest("sd_load_failed", (err as Error).message);
      }
    },
  );

  router.post("/api/images/engine/unload", {}, async () => ({ engine: await stopSd() }));

  router.post("/api/images/generate", { body: GenerateBody }, async ({ body }) => {
    if (!sdBaseUrl()) {
      throw HttpError.conflict(
        "engine_down",
        "Görsel motoru çalışmıyor. Önce bir model yükleyin.",
      );
    }

    let initImage: string | undefined;
    let parentId: string | null = null;
    if (body.initImageId) {
      const parent = getImage(body.initImageId);
      if (!parent) throw HttpError.notFound("Kaynak görsel bulunamadı.");
      const file = resolveInside(OUTPUTS_DIR, parent.filename);
      initImage = (await fsp.readFile(file)).toString("base64");
      parentId = parent.id;
    }

    try {
      const { job } = startGeneration({
        prompt: body.prompt,
        negativePrompt: body.negativePrompt ?? "",
        width: body.width ?? 512,
        height: body.height ?? 512,
        seed: body.seed ?? -1,
        batchCount: body.batchCount ?? 1,
        sampling: {
          steps: body.steps ?? 20,
          cfgScale: body.cfgScale ?? 7,
          ...(body.sampler ? { sampleMethod: body.sampler } : {}),
          ...(body.scheduler ? { scheduler: body.scheduler } : {}),
        },
        ...(body.hires ? { hires: body.hires } : {}),
        ...(initImage ? { initImage, strength: body.strength ?? 0.75 } : {}),
        ...(body.clipSkip !== undefined ? { clipSkip: body.clipSkip } : {}),
        parentId,
      });
      return { job };
    } catch (err) {
      if (err instanceof SdError) {
        throw HttpError.badRequest("sd_error", err.message);
      }
      throw err;
    }
  });

  router.get("/api/images/jobs", {}, () => ({ jobs: imageJobs() }));

  router.post("/api/images/jobs/:id/cancel", {}, async ({ params }) => ({
    ok: await cancelJob(params["id"] as string),
  }));

  router.post("/api/images/jobs/clear", {}, () => {
    clearFinishedImageJobs();
    return { jobs: imageJobs() };
  });

  router.get(
    "/api/images/gallery",
    {
      query: z.object({
        q: z.string().max(200).optional(),
        favorites: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
    },
    ({ query }) => ({
      images: query.q
        ? searchImages(query.q, query.limit ?? 100)
        : listImages({
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            favoritesOnly: query.favorites === "1",
          }),
    }),
  );

  router.post(
    "/api/images/:id/favorite",
    { body: z.object({ favorite: z.boolean() }) },
    ({ params, body }) => {
      const id = params["id"] as string;
      if (!getImage(id)) throw HttpError.notFound("Görsel bulunamadı.");
      setFavorite(id, body.favorite);
      return { image: getImage(id) };
    },
  );

  router.del("/api/images/:id", {}, async ({ params }) => {
    const image = deleteImage(params["id"] as string);
    if (!image) throw HttpError.notFound("Görsel bulunamadı.");
    // Kayıt gittiyse dosya da gitmeli; aksi hâlde çıktı klasörü sessizce şişer.
    await fsp.rm(resolveInside(OUTPUTS_DIR, image.filename)).catch(() => undefined);
    return { ok: true };
  });

  /**
   * Görsel dosyası. `<img src>` özel başlık gönderemediği için istemci bunu
   * `fetch` ile çeker ve blob URL'i üretir -- token'ı adres çubuğuna
   * koymamanın bedeli bu, ve ucuz.
   */
  router.get("/api/images/file/:filename", {}, ({ params, res }) => {
    const file = resolveInside(OUTPUTS_DIR, params["filename"] as string);
    if (!fs.existsSync(file)) throw HttpError.notFound("Görsel dosyası bulunamadı.");
    const bytes = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": bytes.length,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(bytes);
    return undefined;
  });
}
