import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { OUTPUTS_DIR } from "../config.js";
import { loadedImageModel } from "../engines/sd.js";
import { readPng, readSeed } from "./png.js";
import { insertImage, type ImageSource, type StoredImage } from "./store.js";
import {
  SdError,
  cancel as cancelRemote,
  poll,
  submit,
  type GenerateRequest,
} from "./client.js";

/**
 * Üretim işleri.
 *
 * sd-server'ın kendi kuyruğu var; biz onu aynala yapıp arayüze tek bir
 * kimlik altında sunuyoruz. Böylece arayüz motorun adresini hiç bilmiyor
 * ve iptal, hata, kaydetme tek yerden geçiyor.
 */

export type JobState =
  | "queued"
  | "generating"
  | "saving"
  | "done"
  | "error"
  | "cancelled";

export interface ImageJob {
  id: string;
  state: JobState;
  prompt: string;
  batchCount: number;
  queuePosition: number;
  imageIds: string[];
  error: string | null;
  startedAt: number;
  ms: number;
}

const POLL_INTERVAL_MS = 500;
/** Tek bir işin üst sınırı; motor takılırsa iş sonsuza kadar asılı kalmasın. */
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

const jobs = new Map<string, ImageJob>();
const remoteIds = new Map<string, string>();
const cancelled = new Set<string>();

export function imageJobs(): ImageJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function getJob(id: string): ImageJob | null {
  return jobs.get(id) ?? null;
}

export function clearFinishedImageJobs(): void {
  for (const [id, job] of jobs) {
    if (job.state === "done" || job.state === "error" || job.state === "cancelled") {
      jobs.delete(id);
      remoteIds.delete(id);
      cancelled.delete(id);
    }
  }
}

export interface GenerateOptions extends GenerateRequest {
  source?: ImageSource;
  parentId?: string | null;
}

/**
 * İşi başlatır ve hemen döner. `done` sözü işi bekleyenler için (ajan
 * aracı); arayüz yoklamayla ilerler. Tek kod yolu, iki kullanım.
 */
export function startGeneration(options: GenerateOptions): {
  job: ImageJob;
  done: Promise<StoredImage[]>;
} {
  const job: ImageJob = {
    id: crypto.randomUUID(),
    state: "queued",
    prompt: options.prompt,
    batchCount: options.batchCount,
    queuePosition: 0,
    imageIds: [],
    error: null,
    startedAt: Date.now(),
    ms: 0,
  };
  jobs.set(job.id, job);
  return { job, done: run(job, options) };
}

async function run(job: ImageJob, options: GenerateOptions): Promise<StoredImage[]> {
  try {
    const remoteId = await submit(options);
    remoteIds.set(job.id, remoteId);
    if (cancelled.has(job.id)) {
      await cancelRemote(remoteId).catch(() => undefined);
      throw new SdError("İş iptal edildi.", "cancelled");
    }

    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let images: string[] = [];
    for (;;) {
      if (Date.now() > deadline) {
        await cancelRemote(remoteId).catch(() => undefined);
        throw new SdError("Üretim zaman aşımına uğradı.", "timeout");
      }
      await sleep(POLL_INTERVAL_MS);
      const remote = await poll(remoteId);
      job.queuePosition = remote.queuePosition;
      job.ms = Date.now() - job.startedAt;

      if (remote.status === "generating") job.state = "generating";
      if (remote.status === "completed") {
        images = remote.images;
        break;
      }
      if (remote.status === "failed") {
        throw new SdError(remote.error ?? "Üretim başarısız oldu.");
      }
      if (remote.status === "cancelled") {
        job.state = "cancelled";
        job.ms = Date.now() - job.startedAt;
        return [];
      }
    }

    job.state = "saving";
    const saved = await saveAll(images, options, job);
    job.imageIds = saved.map((image) => image.id);
    job.state = "done";
    job.ms = Date.now() - job.startedAt;
    return saved;
  } catch (err) {
    job.state = cancelled.has(job.id) ? "cancelled" : "error";
    job.error = err instanceof SdError ? err.message : (err as Error).message;
    job.ms = Date.now() - job.startedAt;
    return [];
  }
}

async function saveAll(
  images: string[],
  options: GenerateOptions,
  job: ImageJob,
): Promise<StoredImage[]> {
  await fsp.mkdir(OUTPUTS_DIR, { recursive: true });
  const model = loadedImageModel() ?? "";
  const saved: StoredImage[] = [];

  for (let index = 0; index < images.length; index += 1) {
    const bytes = Buffer.from(images[index] as string, "base64");
    const info = readPng(bytes);
    // Tohumu istekten değil dosyadan okuruz: -1 gönderildiğinde gerçek
    // değeri yalnızca motor bilir ve yeniden üretim ona bağlı.
    const seed = readSeed(info) ?? options.seed;

    const filename = `${job.startedAt}-${job.id.slice(0, 8)}-${index}.png`;
    await fsp.writeFile(path.join(OUTPUTS_DIR, filename), bytes);

    saved.push(
      insertImage({
        filename,
        prompt: options.prompt,
        negativePrompt: options.negativePrompt ?? "",
        model,
        sampler: options.sampling.sampleMethod ?? "",
        scheduler: options.sampling.scheduler ?? "",
        steps: options.sampling.steps,
        cfgScale: options.sampling.cfgScale,
        seed,
        width: info.width || options.width,
        height: info.height || options.height,
        source: options.source ?? (options.initImage ? "img2img" : "txt2img"),
        parentId: options.parentId ?? null,
        hires: options.hires?.enabled ?? false,
        ms: Math.round(job.ms / Math.max(1, images.length)),
      }),
    );
  }
  return saved;
}

export async function cancelJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.state === "done" || job.state === "error") return false;
  cancelled.add(id);
  const remoteId = remoteIds.get(id);
  // Uzak kimlik henüz yoksa iptal işareti yeterli: gönderim tamamlanınca
  // işaret görülüp iş orada iptal edilir.
  if (remoteId) await cancelRemote(remoteId).catch(() => undefined);
  job.state = "cancelled";
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
