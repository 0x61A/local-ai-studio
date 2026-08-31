import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MODELS_DIR } from "../config.js";
import { llamaEngine, llamaLoadState, startLlama, stopLlama } from "../engines/llama.js";
import { getBudget, planLoad } from "../hardware/budget.js";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import { downloads } from "../models/download.js";
import { GgufParseError, readGgufInfo } from "../models/gguf.js";
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
});

export interface LocalModel {
  filename: string;
  sizeBytes: number;
  architecture: string;
  parameters: string;
  quantization: string;
  contextLength: number;
  isEmbedding: boolean;
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

  router.post("/api/downloads", { body: DownloadBody }, ({ body }) =>
    downloads.enqueue({
      url: body.url,
      filename: body.filename,
      targetDir: MODELS_DIR,
      expectedSha256: body.sha256 ?? null,
    }),
  );

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
    }
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
