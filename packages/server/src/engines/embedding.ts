import fs from "node:fs";
import path from "node:path";
import { MODELS_DIR } from "../config.js";
import { planLoad, release, reserve } from "../hardware/budget.js";
import { readGgufInfo } from "../models/gguf.js";
import { buildArgs, llamaBinary } from "./llama.js";
import { Engine, httpProbe, type EngineStatus } from "./supervisor.js";

/**
 * Gömme motoru: sohbet motorundan ayrı bir llama-server örneği.
 *
 * Neden ayrı: `--embeddings --pooling mean` sunucuyu havuzlama kipine alır,
 * bu kipte üretimli sohbet doğru çalışmaz. İkisi aynı süreçte olamayacağı
 * için ayrı yuva gerekir -- bütçe yöneticisi tam olarak bunun için
 * ayırma tabanlı yazılmıştı; sohbet modeli yüklüyken gömme modeli de
 * bütçe yeterse yanında durur.
 */

const ENGINE_ID = "embed";
const PREFERRED_PORT = 18090;
/**
 * Gömme modellerinde tüm dizi tek yığında işlenir; bağlamı büyütmek
 * yığın belleğini doğrusal büyütür ve hiçbir şey kazandırmaz. Parçalarımız
 * zaten ~2 bin karakter.
 */
const MAX_EMBED_CONTEXT = 8192;

export const embeddingEngine = new Engine(ENGINE_ID);

let loadedModel: string | null = null;

export function embeddingStatus(): EngineStatus & { model: string } {
  return { ...embeddingEngine.status(), model: loadedModel ?? "" };
}

export function embeddingBaseUrl(): string | null {
  const base = embeddingEngine.baseUrl();
  return base ? `${base}/v1` : null;
}

export async function startEmbedding(filename: string): Promise<EngineStatus> {
  const binary = llamaBinary();
  if (!binary) {
    throw new Error(
      "llama.cpp motoru kurulu değil. `bash scripts/setup/fetch-llama.sh` çalıştırın.",
    );
  }
  const modelPath = path.join(MODELS_DIR, path.basename(filename));
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Gömme modeli bulunamadı: ${path.basename(filename)}`);
  }

  const info = readGgufInfo(modelPath);
  release(ENGINE_ID);
  const plan = planLoad(info, { contextSize: MAX_EMBED_CONTEXT });
  if (!plan.fits) throw new Error(plan.reason);

  reserve(ENGINE_ID, plan.estimatedMb);
  loadedModel = path.basename(modelPath);

  const status = await embeddingEngine.start({
    binary,
    model: loadedModel,
    footprintMb: plan.estimatedMb,
    preferredPort: PREFERRED_PORT,
    args: (port) => buildArgs(modelPath, port, plan, { embedding: true }),
    probe: (port) => httpProbe(`http://127.0.0.1:${port}/health`, 1500),
    readyTimeoutMs: 300_000,
  });

  if (status.state !== "ready") {
    release(ENGINE_ID);
    loadedModel = null;
  }
  return status;
}

export async function stopEmbedding(): Promise<EngineStatus> {
  const status = await embeddingEngine.stop();
  release(ENGINE_ID);
  loadedModel = null;
  return status;
}
