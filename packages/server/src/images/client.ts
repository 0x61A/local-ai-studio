import { sdBaseUrl } from "../engines/sd.js";

/**
 * sd-server'ın native async iş API'si (`/sdcpp/v1`).
 *
 * A1111 uyumlu uç (`/sdapi/v1`) senkron çalışır: 20 adımlık bir üretim
 * boyunca istek açık kalır, ilerleme görünmez, iptal edilemez. Native uç
 * iş kimliği döner; sıra konumu, iptal ve hata kodu oradan gelir.
 */

export class SdError extends Error {
  constructor(message: string, readonly code = "sd_error") {
    super(message);
    this.name = "SdError";
  }
}

export type JobStatus = "queued" | "generating" | "completed" | "failed" | "cancelled";

export interface RemoteJob {
  id: string;
  status: JobStatus;
  queuePosition: number;
  images: string[];
  error: string | null;
}

export interface SamplingParams {
  sampleMethod?: string;
  scheduler?: string;
  steps: number;
  cfgScale: number;
}

export interface HiresParams {
  enabled: boolean;
  upscaler?: string;
  scale?: number;
  steps?: number;
  denoisingStrength?: number;
}

export interface GenerateRequest {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed: number;
  batchCount: number;
  sampling: SamplingParams;
  hires?: HiresParams;
  /** img2img: ham base64 PNG. */
  initImage?: string;
  /** img2img gürültü oranı; 0 = girdiyi koru, 1 = tamamen yeniden üret. */
  strength?: number;
  clipSkip?: number;
}

export interface Capabilities {
  modelName: string;
  samplers: string[];
  schedulers: string[];
  upscalers: string[];
  defaults: Record<string, unknown>;
}

function base(): string {
  const url = sdBaseUrl();
  if (!url) {
    throw new SdError(
      "Görsel motoru çalışmıyor. Görsel sekmesinden bir model yükleyin.",
      "engine_down",
    );
  }
  return url;
}

export async function capabilities(): Promise<Capabilities> {
  const response = await fetch(`${base()}/sdcpp/v1/capabilities`);
  if (!response.ok) throw new SdError(`Yetenekler okunamadı: HTTP ${response.status}`);
  const payload = (await response.json()) as {
    model?: { name?: string };
    samplers?: string[];
    schedulers?: string[];
    upscalers?: Array<{ name?: string } | string>;
    defaults?: Record<string, unknown>;
  };
  return {
    modelName: payload.model?.name ?? "",
    samplers: payload.samplers ?? [],
    schedulers: payload.schedulers ?? [],
    upscalers: (payload.upscalers ?? []).map((entry) =>
      typeof entry === "string" ? entry : (entry.name ?? ""),
    ).filter(Boolean),
    defaults: payload.defaults ?? {},
  };
}

export async function submit(request: GenerateRequest): Promise<string> {
  const response = await fetch(`${base()}/sdcpp/v1/img_gen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toWire(request)),
  });
  if (!response.ok) {
    throw new SdError(await describeFailure(response), `http_${response.status}`);
  }
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new SdError("sd-server iş kimliği döndürmedi.");
  return payload.id;
}

export async function poll(jobId: string): Promise<RemoteJob> {
  const response = await fetch(`${base()}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}`);
  if (response.status === 404 || response.status === 410) {
    throw new SdError("İş artık sunucuda yok.", "job_gone");
  }
  if (!response.ok) throw new SdError(await describeFailure(response));

  const payload = (await response.json()) as {
    id?: string;
    status?: JobStatus;
    queue_position?: number;
    result?: { images?: Array<{ b64_json?: string }> } | null;
    error?: { message?: string } | null;
  };
  return {
    id: payload.id ?? jobId,
    status: payload.status ?? "queued",
    queuePosition: payload.queue_position ?? 0,
    images: (payload.result?.images ?? [])
      .map((image) => image.b64_json ?? "")
      .filter(Boolean),
    error: payload.error?.message ?? null,
  };
}

export async function cancel(jobId: string): Promise<boolean> {
  const response = await fetch(
    `${base()}/sdcpp/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
  return response.ok;
}

/**
 * İstek gövdesi. Belirtilmeyen alanlar gönderilmez: sunucu kendi
 * varsayılanlarını uygular ve model ailesine göre değişen değerleri
 * (flow_shift, eta) burada tahmin etmeye çalışmak yanlış olurdu.
 */
export function toWire(request: GenerateRequest): Record<string, unknown> {
  const sampleParams: Record<string, unknown> = {
    sample_steps: request.sampling.steps,
    guidance: { txt_cfg: request.sampling.cfgScale },
  };
  if (request.sampling.sampleMethod) {
    sampleParams["sample_method"] = request.sampling.sampleMethod;
  }
  if (request.sampling.scheduler) sampleParams["scheduler"] = request.sampling.scheduler;

  const body: Record<string, unknown> = {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt ?? "",
    width: request.width,
    height: request.height,
    seed: request.seed,
    batch_count: request.batchCount,
    sample_params: sampleParams,
    output_format: "png",
  };
  if (request.clipSkip !== undefined) body["clip_skip"] = request.clipSkip;
  if (request.initImage) {
    body["init_image"] = request.initImage;
    body["strength"] = request.strength ?? 0.75;
  }
  if (request.hires?.enabled) {
    body["hires"] = {
      enabled: true,
      upscaler: request.hires.upscaler ?? "Latent",
      scale: request.hires.scale ?? 2.0,
      steps: request.hires.steps ?? 0,
      denoising_strength: request.hires.denoisingStrength ?? 0.7,
    };
  }
  return body;
}

async function describeFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: { message?: string } };
    if (payload.error?.message) return payload.error.message;
  } catch {
    // Gövde JSON değilse ham metin daha bilgilendirici.
  }
  return text.trim() || `sd-server HTTP ${response.status}`;
}
