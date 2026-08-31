import fs from "node:fs";
import path from "node:path";
import { RUNTIME_DIR } from "../config.js";
import { planLoad, release, reserve, type LoadPlan } from "../hardware/budget.js";
import { readGgufInfo, type GgufInfo } from "../models/gguf.js";
import { Engine, httpProbe, type EngineStatus } from "./supervisor.js";

/**
 * llama.cpp motoru.
 *
 * Yükleme parametreleri (bağlam, katman) tahminle değil, GGUF başlığından
 * okunan gerçek değerlere dayanan bütçe planıyla belirlenir. Böylece OOM'a
 * girmeden önce ne olacağı bilinir.
 */

const ENGINE_ID = "llama";
const PREFERRED_PORT = 18080;

export const llamaEngine = new Engine(ENGINE_ID);

/** Son yükleme planı ve model bilgisi -- arayüzde gösterilir. */
let lastLoad: { plan: LoadPlan; info: GgufInfo; modelPath: string } | null = null;
/** Model yükleme ilerlemesi (0-100). llama-server çıktısından okunur. */
let loadProgress = 0;

export function llamaBinary(): string | null {
  const candidate = path.join(RUNTIME_DIR, "engines", "llama", "llama-server");
  return isExecutable(candidate) ? candidate : null;
}

export function llamaLoadState(): {
  plan: LoadPlan | null;
  info: GgufInfo | null;
  progress: number;
} {
  return {
    plan: lastLoad?.plan ?? null,
    info: lastLoad?.info ?? null,
    progress: loadProgress,
  };
}

export interface LlamaStartOptions {
  contextSize?: number;
  /** Görsel anlama için mmproj dosyası. */
  projectorPath?: string;
  /** Gömme modu: sohbet yerine /v1/embeddings sunar. */
  embedding?: boolean;
}

export async function startLlama(
  modelPath: string,
  options: LlamaStartOptions = {},
): Promise<EngineStatus & { plan: LoadPlan }> {
  const binary = llamaBinary();
  if (!binary) {
    throw new Error(
      "llama.cpp motoru kurulu değil. `bash scripts/setup/fetch-llama.sh` çalıştırın.",
    );
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model dosyası bulunamadı: ${path.basename(modelPath)}`);
  }

  const info = readGgufInfo(modelPath);
  // Yeniden planlarken kendi eski ayırmamızı bütçeden düşmeyelim.
  release(ENGINE_ID);
  const plan = planLoad(info, options.contextSize ? { contextSize: options.contextSize } : {});

  if (!plan.fits) {
    throw new Error(plan.reason);
  }

  loadProgress = 0;
  lastLoad = { plan, info, modelPath };
  reserve(ENGINE_ID, plan.estimatedMb);

  const status = await llamaEngine.start({
    binary,
    model: path.basename(modelPath),
    footprintMb: plan.estimatedMb,
    preferredPort: PREFERRED_PORT,
    args: (port) => buildArgs(modelPath, port, plan, options),
    probe: (port) => httpProbe(`http://127.0.0.1:${port}/health`, 1500),
    onLine: (line) => {
      const percent = parseLoadProgress(line);
      if (percent !== null) loadProgress = percent;
    },
    readyTimeoutMs: 600_000,
  });

  if (status.state !== "ready") {
    release(ENGINE_ID);
    lastLoad = null;
  } else {
    loadProgress = 100;
  }
  return { ...status, plan };
}

export async function stopLlama(): Promise<EngineStatus> {
  const status = await llamaEngine.stop();
  release(ENGINE_ID);
  lastLoad = null;
  loadProgress = 0;
  return status;
}

export function buildArgs(
  modelPath: string,
  port: number,
  plan: LoadPlan,
  options: LlamaStartOptions = {},
): string[] {
  const common = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", String(plan.contextSize),
    "--n-gpu-layers", plan.gpuLayers < 0 ? "999" : String(plan.gpuLayers),
    // Yerleşik web arayüzü gereksiz: bizim arayüzümüz var.
    "--no-webui",
  ];

  if (options.embedding) {
    // Havuzlanmış gömme, dizinin tamamının tek yığında işlenmesini ister:
    // yığın bağlamdan küçükse llama.cpp isteği reddeder. Sohbete özgü
    // bayraklar (jinja şablonu, KV nicemleme) burada anlamsız.
    return [
      ...common,
      "--embeddings",
      "--pooling", "mean",
      "--batch-size", String(plan.contextSize),
      "--ubatch-size", String(plan.contextSize),
    ];
  }

  const args = [
    ...common,
    // Modelin kendi sohbet şablonunu kullanır; araç çağrısı desteği bununla gelir.
    "--jinja",
    // Flash attention KV önbelleğini nicemlemenin ön koşulu.
    "--flash-attn", "on",
    "--cache-type-k", "q8_0",
    "--cache-type-v", "q8_0",
  ];

  if (options.projectorPath) {
    args.push("--mmproj", options.projectorPath);
  }
  return args;
}

/**
 * llama-server yükleme ilerlemesini stderr'e basar. Biçim sürümler arasında
 * değiştiği için birkaç kalıba birden bakarız; hiçbiri tutmazsa null.
 */
export function parseLoadProgress(line: string): number | null {
  // "load_tensors: loading model tensors, this can take a while... (mmap = true)"
  // "....................  45%"
  const percent = line.match(/(\d{1,3})\s*%/);
  if (percent?.[1]) {
    const value = Number.parseInt(percent[1], 10);
    if (value >= 0 && value <= 100) return value;
  }
  if (/all tensors loaded|model loaded|server is listening/i.test(line)) return 100;
  return null;
}

function isExecutable(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.X_OK);
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}
