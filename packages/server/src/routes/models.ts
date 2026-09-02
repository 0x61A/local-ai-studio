import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MODELS_DIR } from "../config.js";
import { llamaEngine, llamaLoadState, startLlama, stopLlama } from "../engines/llama.js";
import { getBudget, planLoad } from "../hardware/budget.js";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import { downloads } from "../models/download.js";
import { getCatalog } from "../models/catalog.js";
import { GgufParseError, readGgufInfo } from "../models/gguf.js";
import { findProjectorFor } from "../models/projector.js";
import {
  getModelDetail,
  isProjector,
  pickBestFit,
  searchGgufModels,
} from "../models/huggingface.js";
import { resolveInside } from "../security/paths.js";

const DownloadBody = z.object({
  url: z.string().url(),
  filename: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
});

const LoadBody = z.object({
  filename: z.string().min(1).max(255),
  contextSize: z.number().int().min(512).max(1_000_000).optional(),
  projector: z.string().max(255).optional(),
  powerMode: z.enum(["performance", "balanced", "eco", "custom"]).optional(),
  cpuThreads: z.number().int().min(1).max(128).optional(),
  ubatchSize: z.number().int().min(32).max(1024).optional(),
  gpuOffload: z.boolean().optional(),
});

/**
 * Hugging Face adresinden dosyanin beklenen SHA256'sini bulur.
 *
 * Bulunamazsa null doner: hash yoksa indirme yine de yapilir (eski davranis),
 * ama bulunabildigi her yerde dogrulanir.
 */
async function lookupHfSha256(rawUrl: string, filename: string): Promise<string | null> {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "huggingface.co") return null;
    // /<owner>/<name>/resolve/<rev>/<path>
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[2] !== "resolve") return null;
    const detail = await getModelDetail(`${parts[0]}/${parts[1]}`);
    const wanted = decodeURIComponent(parts.slice(4).join("/")) || filename;
    return detail.files.find((file) => file.path === wanted)?.sha256 ?? null;
  } catch {
    return null;
  }
}

export interface LocalModel {
  filename: string;
  sizeBytes: number;
  architecture: string;
  parameters: string;
  quantization: string;
  contextLength: number;
  isEmbedding: boolean;
  /** Eşleşen mmproj dosyası; yoksa görsel anlama çalışmaz. */
  projector: string | null;
  /** Bu makinede çalışır mı, hangi ayarlarla. */
  fits: boolean;
  planReason: string;
  estimatedMb: number;
  /** Okunamadıysa neden. */
  error: string | null;
}

export function listLocalModels(): LocalModel[] {
  if (!fs.existsSync(MODELS_DIR)) return [];
  return fs
    .readdirSync(MODELS_DIR)
    .filter((name) => name.toLowerCase().endsWith(".gguf") && !isProjector(name))
    .map((filename) => describeLocalModel(filename))
    .sort((a, b) => a.filename.localeCompare(b.filename, "tr"));
}

function describeLocalModel(filename: string): LocalModel {
  const filePath = path.join(MODELS_DIR, filename);
  const sizeBytes = safeSize(filePath);
  try {
    const info = readGgufInfo(filePath);
    const plan = planLoad(info);
    return {
      filename,
      sizeBytes,
      architecture: info.architecture,
      parameters: info.name,
      quantization: info.quantization,
      contextLength: info.trainContextLength,
      isEmbedding: info.isEmbedding,
      projector: findProjectorFor(MODELS_DIR, filename),
      fits: plan.fits,
      planReason: plan.reason,
      estimatedMb: plan.estimatedMb,
      error: null,
    };
  } catch (err) {
    // Bozuk ya da yarım dosya listeyi bozmamalı; nedeni gösterilir.
    return {
      filename,
      sizeBytes,
      architecture: "?",
      parameters: "",
      quantization: "?",
      contextLength: 0,
      isEmbedding: false,
      projector: null,
      fits: false,
      planReason: "",
      estimatedMb: 0,
      error:
        err instanceof GgufParseError
          ? err.message
          : `Model okunamadı: ${(err as Error).message}`,
    };
  }
}

export function registerModelRoutes(router: Router): void {
  router.get("/api/models", {}, () => ({
    models: listLocalModels(),
    budget: getBudget(),
  }));

  router.get(
    "/api/models/catalog",
    { query: z.object({ lang: z.enum(["tr", "en"]).optional() }).optional() },
    ({ query }) => {
      const budget = getBudget();
      return {
        catalog: getCatalog(query?.lang ?? "tr", budget.freeMb),
        budget,
      };
    },
  );

  router.del("/api/models/:filename", {}, ({ params }) => {
    const target = resolveInside(MODELS_DIR, params["filename"] as string);
    if (!fs.existsSync(target)) throw HttpError.notFound("Model dosyası bulunamadı.");
    if (llamaEngine.status().model === path.basename(target)) {
      throw HttpError.conflict("model_in_use", "Bu model yüklü. Önce durdurun.");
    }
    fs.rmSync(target);
    return { ok: true };
  });

  // -- Hugging Face ----------------------------------------------------------

  router.get(
    "/api/hf/search",
    { query: z.object({ q: z.string().min(1).max(200) }) },
    async ({ query }) => searchGgufModels(query.q, 20),
  );

  router.get("/api/hf/models/:owner/:name", {}, async ({ params }) => {
    const repo = `${params["owner"]}/${params["name"]}`;
    const detail = await getModelDetail(repo);
    const budget = getBudget();
    return {
      ...detail,
      // Bu makineye hangi nicemlemenin uyduğunu önerelim.
      recommended: pickBestFit(detail.files, budget.freeMb)?.path ?? null,
      budget,
    };
  });

  // -- İndirmeler ------------------------------------------------------------

  router.get("/api/downloads", {}, () => downloads.list());

  router.post("/api/downloads", { body: DownloadBody }, async ({ body }) => {
    // Katalog karti dosya listesini hic cekmedigi icin elinde hash yok.
    // Dogrulamasiz indirmek projenin kendi guvenlik sozunu bozardi; hash'i
    // burada, tek yerde, Hugging Face'in kendi listesinden tamamliyoruz.
    const sha256 = body.sha256 ?? (await lookupHfSha256(body.url, body.filename));
    return downloads.enqueue({
      url: body.url,
      filename: body.filename,
      targetDir: MODELS_DIR,
      expectedSha256: sha256,
    });
  });

  router.del("/api/downloads/:id", {}, ({ params }) => ({
    ok: downloads.cancel(params["id"] as string),
  }));

  router.post("/api/downloads/clear", {}, () => {
    downloads.clearFinished();
    return { ok: true };
  });

  // -- Motor -----------------------------------------------------------------

  router.get("/api/engine", {}, () => ({
    ...llamaEngine.status(),
    ...llamaLoadState(),
    budget: getBudget(),
  }));

  router.post("/api/engine/load", { body: LoadBody }, async ({ body }) => {
    const modelPath = resolveInside(MODELS_DIR, body.filename);
    const options: Parameters<typeof startLlama>[1] = {};
    if (body.contextSize) options.contextSize = body.contextSize;
    if (body.projector) {
      options.projectorPath = resolveInside(MODELS_DIR, body.projector);
    } else {
      // Gorsel model projektorsuz yuklenirse hata vermez, sadece goremez.
      // Eslesen dosya diskteyse elle secmesini beklemeyiz.
      const auto = findProjectorFor(MODELS_DIR, body.filename);
      if (auto) options.projectorPath = resolveInside(MODELS_DIR, auto);
    }
    if (body.powerMode) options.powerMode = body.powerMode;
    if (body.cpuThreads) options.cpuThreads = body.cpuThreads;
    if (body.ubatchSize) options.ubatchSize = body.ubatchSize;
    if (body.gpuOffload !== undefined) options.gpuOffload = body.gpuOffload;
    try {
      const status = await startLlama(modelPath, options);
      if (status.state !== "ready") {
        throw HttpError.conflict(
          "engine_failed",
          status.error ?? "Motor başlatılamadı.",
        );
      }
      return status;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw HttpError.conflict("engine_failed", (err as Error).message);
    }
  });

  router.post("/api/engine/unload", {}, async () => stopLlama());

  router.get("/api/engine/logs", {}, () => ({ lines: llamaEngine.recentLogs() }));
}

function safeSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
