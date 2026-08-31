import { execFileSync } from "node:child_process";
import os from "node:os";
import type { GpuInfo, SystemInfo, Telemetry } from "@studio/shared";
import { APP_VERSION } from "../config.js";

/**
 * Donanim tespiti. Eski projedeki getHardwareSpecs/getGpuInfo mantiginin
 * platform basina ayrilmis hali. Faz 0'da yalnizca macOS yolu doludur;
 * Windows/Linux dallari faz 6'da ayni arayuzu doldurur.
 */

const MB = 1024 * 1024;

/** system_profiler pahali (~1sn); surec omru boyunca bir kez calisir. */
let gpuCache: GpuInfo | null = null;

export function getGpuInfo(): GpuInfo {
  if (gpuCache) return gpuCache;
  gpuCache = os.platform() === "darwin" ? detectMacGpu() : detectUnknownGpu();
  return gpuCache;
}

function detectMacGpu(): GpuInfo {
  const isAppleSilicon = sysctlNumber("hw.optional.arm64") === 1;
  const name = isAppleSilicon
    ? sysctlString("machdep.cpu.brand_string") || "Apple Silicon GPU"
    : firstLine(runQuiet("system_profiler", ["SPDisplaysDataType"])) ||
      "macOS GPU";

  return {
    name: isAppleSilicon ? `${name} (tumlesik GPU)` : name,
    vendor: isAppleSilicon ? "apple" : "unknown",
    // Apple Silicon'da bellek birlesiktir. Metal'in onerdigi calisma kumesi
    // fiziksel RAM'in ~%75'idir; model yerlestirme butcesi bunu kullanir.
    vramTotalMb: isAppleSilicon
      ? Math.floor((os.totalmem() * 0.75) / MB)
      : 0,
    accelerator: isAppleSilicon ? "Metal" : "CPU",
  };
}

function detectUnknownGpu(): GpuInfo {
  // Faz 6: nvidia-smi / vulkaninfo / sysfs dallari buraya gelir.
  return { name: "Bilinmiyor", vendor: "unknown", vramTotalMb: 0, accelerator: "CPU" };
}

// -- Bellek ------------------------------------------------------------------

/**
 * Gercekten kullanilabilir bellek.
 *
 * macOS'ta os.freemem() yalnizca "free" sayfalari sayar; onbelleklenmis ama
 * geri alinabilir sayfalari saymaz, bu yuzden 16 GB'lik bir makinede surekli
 * ~0.5 GB gosterir. Model yerlestirme butcesi bu sayiya guvenemez, bu yuzden
 * vm_stat'tan geri alinabilir sayfalari da toplariz:
 *   kullanilabilir = free + inactive + speculative + purgeable
 */
const AVAILABLE_CACHE_MS = 1000;
let availableCache: { value: number; at: number } | null = null;

export function getAvailableMemoryMb(): number {
  const now = Date.now();
  if (availableCache && now - availableCache.at < AVAILABLE_CACHE_MS) {
    return availableCache.value;
  }
  const value =
    os.platform() === "darwin"
      ? (readMacAvailableMb() ?? Math.floor(os.freemem() / MB))
      : Math.floor(os.freemem() / MB);
  availableCache = { value, at: now };
  return value;
}

function readMacAvailableMb(): number | null {
  const output = runQuiet("vm_stat", []);
  if (!output) return null;
  return parseVmStatAvailableMb(output, sysctlNumber("hw.pagesize") || 4096);
}

/** vm_stat ciktisini ayristirir. Saf fonksiyon: test edilebilsin diye disari acilir. */
export function parseVmStatAvailableMb(
  output: string,
  pageSizeBytes: number,
): number | null {
  const pages = (label: string): number => {
    const match = output.match(new RegExp(`^${label}:\\s+(\\d+)`, "m"));
    return match?.[1] ? Number.parseInt(match[1], 10) : 0;
  };

  const reclaimable =
    pages("Pages free") +
    pages("Pages inactive") +
    pages("Pages speculative") +
    pages("Pages purgeable");

  if (reclaimable <= 0) return null;
  return Math.floor((reclaimable * pageSizeBytes) / MB);
}

export function getPhysicalCores(): number {
  if (os.platform() === "darwin") {
    const value = sysctlNumber("hw.physicalcpu");
    if (value > 0) return value;
  }
  // Guvenli geri dusum: mantiksal cekirdegin yarisi, en az 1.
  return Math.max(1, Math.floor(os.cpus().length / 2));
}

export function getSystemInfo(): SystemInfo {
  const cpus = os.cpus();
  return {
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: {
      model: cpus[0]?.model ?? "Bilinmiyor",
      physicalCores: getPhysicalCores(),
      logicalCores: cpus.length,
    },
    memory: {
      totalMb: Math.floor(os.totalmem() / MB),
      freeMb: getAvailableMemoryMb(),
    },
    gpu: getGpuInfo(),
    node: process.version,
    appVersion: APP_VERSION,
  };
}

// -- CPU kullanimi: os.cpus() tick farkindan hesaplanir -----------------------

interface CpuSample {
  idle: number;
  total: number;
}

let lastSample: CpuSample = sampleCpu();

function sampleCpu(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, value] of Object.entries(cpu.times)) {
      total += value;
      if (kind === "idle") idle += value;
    }
  }
  return { idle, total };
}

export function getCpuUsagePercent(): number {
  const current = sampleCpu();
  const idleDelta = current.idle - lastSample.idle;
  const totalDelta = current.total - lastSample.total;
  lastSample = current;
  if (totalDelta <= 0) return 0;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

export function getTelemetry(): Telemetry {
  const totalMb = Math.floor(os.totalmem() / MB);
  return {
    cpuUsagePercent: getCpuUsagePercent(),
    memoryUsedMb: Math.max(0, totalMb - getAvailableMemoryMb()),
    memoryTotalMb: totalMb,
    // Faz 1: VRAM butce yoneticisi yuklu motorlarin ayak izini toplayip verir.
    vramUsedMb: 0,
    vramTotalMb: getGpuInfo().vramTotalMb,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

// -- Yardimcilar --------------------------------------------------------------

function runQuiet(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function sysctlString(key: string): string {
  return runQuiet("sysctl", ["-n", key]).trim();
}

function sysctlNumber(key: string): number {
  const value = Number.parseInt(sysctlString(key), 10);
  return Number.isFinite(value) ? value : 0;
}

function firstLine(value: string): string {
  const line = value
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("Chipset Model:"));
  return line ? line.replace("Chipset Model:", "").trim() : "";
}
