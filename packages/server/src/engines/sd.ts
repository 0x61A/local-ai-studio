import fs from "node:fs";
import path from "node:path";
import { IMAGE_MODELS_DIR, setupCommand } from "../config.js";
import { getBudget, release, reserve } from "../hardware/budget.js";
import { Engine, engineBinary, httpProbe, type EngineStatus } from "./supervisor.js";

/**
 * stable-diffusion.cpp motoru.
 *
 * `sd-cli` yerine `sd-server` kullanılır: tek atışlık CLI her görselde
 * modeli baştan yükler (SD 1.5'te ~10 sn), sunucu bir kez yükleyip bellekte
 * tutar. Referans proje de sunucu kullanıyordu ama A1111 uyumlu ucu
 * doğrudan tarayıcıya proxy'liyordu; biz native async iş API'sini
 * kullanıyoruz -- ilerleme ve iptal ancak orada var.
 */

const ENGINE_ID = "sd";
const PREFERRED_PORT = 18100;
/**
 * Difüzyon ara tensörleri ve VAE çözümü model ağırlıklarının üstüne gelir.
 * SD 1.5'te 512x512 için ~700 MB; büyük çözünürlükte VAE döşeme devreye
 * girdiği için doğrusal büyümez.
 */
const WORKING_MEMORY_MB = 900;

export const sdEngine = new Engine(ENGINE_ID);

let loadedModel: string | null = null;

export function sdBinary(): string | null {
  return engineBinary("sd", "sd-server");
}

export function sdBaseUrl(): string | null {
  return sdEngine.baseUrl();
}

export function sdStatus(): EngineStatus {
  return sdEngine.status();
}

export function loadedImageModel(): string | null {
  return loadedModel;
}

export function listImageModels(): Array<{ filename: string; sizeBytes: number }> {
  if (!fs.existsSync(IMAGE_MODELS_DIR)) return [];
  return fs
    .readdirSync(IMAGE_MODELS_DIR)
    .filter((name) => /\.(gguf|safetensors|ckpt)$/i.test(name))
    .map((filename) => ({
      filename,
      sizeBytes: safeSize(path.join(IMAGE_MODELS_DIR, filename)),
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename, "tr"));
}

/**
 * Görsel modelleri için GGUF başlığı metin modelininki gibi katman/bağlam
 * bildirmez; ayak izi dosya boyutundan tahmin edilir. Tahminin işi bütçe
 * yöneticisine dürüst bir sayı vermek, birebir doğruluk değil.
 */
export function estimateFootprintMb(sizeBytes: number): number {
  return Math.round(sizeBytes / (1024 * 1024)) + WORKING_MEMORY_MB;
}

export async function startSd(filename: string): Promise<EngineStatus> {
  const binary = sdBinary();
  if (!binary) {
    throw new Error(
      `stable-diffusion.cpp motoru kurulu değil. \`${setupCommand("sd")}\` çalıştırın.`,
    );
  }
  const modelPath = path.join(IMAGE_MODELS_DIR, path.basename(filename));
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Görsel modeli bulunamadı: ${path.basename(filename)}`);
  }

  const footprintMb = estimateFootprintMb(safeSize(modelPath));
  release(ENGINE_ID);
  const budget = getBudget();
  if (footprintMb > budget.freeMb) {
    throw new Error(
      `Görsel modeli bütçeye sığmıyor: ~${formatMb(footprintMb)} gerekiyor, ` +
        `${formatMb(budget.freeMb)} boş. Sohbet modelini kaldırmayı deneyin.`,
    );
  }

  reserve(ENGINE_ID, footprintMb);
  loadedModel = path.basename(modelPath);

  const status = await sdEngine.start({
    binary,
    model: loadedModel,
    footprintMb,
    preferredPort: PREFERRED_PORT,
    args: (port) => buildSdArgs(modelPath, port),
    probe: (port) => httpProbe(`http://127.0.0.1:${port}/sdcpp/v1/capabilities`, 1500),
    readyTimeoutMs: 600_000,
  });

  if (status.state !== "ready") {
    release(ENGINE_ID);
    loadedModel = null;
  }
  return status;
}

export async function stopSd(): Promise<EngineStatus> {
  const status = await sdEngine.stop();
  release(ENGINE_ID);
  loadedModel = null;
  return status;
}

export function buildSdArgs(modelPath: string, port: number): string[] {
  return [
    "--model", modelPath,
    "--listen-ip", "127.0.0.1",
    "--listen-port", String(port),
    // Difüzyonda flash attention hem hızlı hem daha az bellek.
    "--diffusion-fa",
    // LoRA ve yüksek çözünürlük yükselticileri model klasörünün altından
    // okunur; kullanıcı dosyayı oraya atınca yeniden başlatmadan görünür.
    "--lora-model-dir", path.join(IMAGE_MODELS_DIR, "lora"),
    "--hires-upscalers-dir", path.join(IMAGE_MODELS_DIR, "upscaler"),
  ];
}

function safeSize(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

function formatMb(megabytes: number): string {
  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${megabytes} MB`;
}
