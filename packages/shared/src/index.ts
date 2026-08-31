/**
 * Server ve web arasindaki tek sozlesme kaynagi.
 * Semalar burada tanimlanir, tipler z.infer ile turetilir; boylece
 * dogrulama ile tip birbirinden ayrilamaz.
 */
import { z } from "zod";

// -- Hata zarfi ---------------------------------------------------------------

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Sema dogrulamasi basarisiz olduysa alan bazli ayrinti. */
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// -- Sistem bilgisi -----------------------------------------------------------

export const GpuInfo = z.object({
  name: z.string(),
  vendor: z.enum(["apple", "nvidia", "amd", "intel", "unknown"]),
  vramTotalMb: z.number(),
  /** Metal / CUDA / Vulkan / ROCm / CPU */
  accelerator: z.string(),
});
export type GpuInfo = z.infer<typeof GpuInfo>;

export const SystemInfo = z.object({
  os: z.object({
    platform: z.string(),
    release: z.string(),
    arch: z.string(),
  }),
  cpu: z.object({
    model: z.string(),
    physicalCores: z.number(),
    logicalCores: z.number(),
  }),
  memory: z.object({
    totalMb: z.number(),
    freeMb: z.number(),
  }),
  gpu: GpuInfo,
  node: z.string(),
  appVersion: z.string(),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

export const Telemetry = z.object({
  cpuUsagePercent: z.number(),
  memoryUsedMb: z.number(),
  memoryTotalMb: z.number(),
  vramUsedMb: z.number(),
  vramTotalMb: z.number(),
  uptimeSeconds: z.number(),
});
export type Telemetry = z.infer<typeof Telemetry>;

export const HealthStatus = z.object({
  ok: z.boolean(),
  version: z.string(),
  /** Motor kimligi -> durum. Faz 1'de llama, faz 4'te sd/whisper eklenir. */
  engines: z.record(z.string(), z.enum(["stopped", "starting", "ready", "error"])),
  issues: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type HealthStatus = z.infer<typeof HealthStatus>;

// -- Ortak sabitler -----------------------------------------------------------
// Sabitler ayri dosyada: web bundle'i onlari zod'u cekmeden alabilsin.

export { AUTH_HEADER, TOKEN_FRAGMENT_KEY } from "./constants.js";
