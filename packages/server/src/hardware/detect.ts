import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { GpuInfo, SystemInfo, Telemetry } from "@studio/shared";
import { APP_VERSION } from "../config.js";

/**
 * Donanim tespiti. Eski projedeki getHardwareSpecs/getGpuInfo mantiginin
 * platform basina ayrilmis hali.
 *
 * Her platform ayni sozu verir: ad, satici, VRAM ve hizlandirici adi.
 * Bilinmeyen deger uydurulmaz -- 0 doner ve butce onu "CPU'ya yerlestir"
 * diye okur. Yanlis bir VRAM tahmini modeli GPU'ya tasiyip OOM ettirirdi.
 */

const MB = 1024 * 1024;

/** system_profiler / nvidia-smi pahali; surec omru boyunca bir kez calisir. */
let gpuCache: GpuInfo | null = null;

export function getGpuInfo(): GpuInfo {
  if (gpuCache) return gpuCache;
  gpuCache = detectGpu();
  return gpuCache;
}

function detectGpu(): GpuInfo {
  switch (os.platform()) {
    case "darwin":
      return detectMacGpu();
    case "linux":
      return detectNvidiaGpu() ?? detectAmdGpu() ?? unknownGpu();
    case "win32":
      return detectNvidiaGpu() ?? detectWindowsGpu() ?? unknownGpu();
    default:
      return unknownGpu();
  }
}

function unknownGpu(): GpuInfo {
  return { name: "Bilinmiyor", vendor: "unknown", vramTotalMb: 0, accelerator: "CPU" };
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

// -- NVIDIA (Windows + Linux ayni arac) --------------------------------------

const NVIDIA_QUERY = [
  "--query-gpu=name,memory.total,memory.free",
  "--format=csv,noheader,nounits",
];

function detectNvidiaGpu(): GpuInfo | null {
  const parsed = parseNvidiaSmi(runQuiet("nvidia-smi", NVIDIA_QUERY));
  if (!parsed) return null;
  return {
    name: parsed.name,
    vendor: "nvidia",
    vramTotalMb: parsed.vramTotalMb,
    accelerator: "CUDA",
  };
}

/**
 * `nvidia-smi --format=csv,noheader,nounits` satiri:
 * `NVIDIA GeForce RTX 4070, 12282, 11534` (ad, toplam MiB, bos MiB).
 * Coklu GPU'da ilk satir kullanilir: llama.cpp varsayilan olarak 0. cihaza
 * yukler, dolayisiyla butcenin bakmasi gereken kart odur.
 */
export function parseNvidiaSmi(
  output: string,
): { name: string; vramTotalMb: number; vramFreeMb: number } | null {
  const line = output.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length < 3) return null;
  const name = parts[0] ?? "";
  const total = Number.parseInt(parts[1] ?? "", 10);
  const free = Number.parseInt(parts[2] ?? "", 10);
  if (!name || !Number.isFinite(total) || total <= 0) return null;
  return {
    name,
    vramTotalMb: total,
    vramFreeMb: Number.isFinite(free) ? Math.max(0, free) : 0,
  };
}

// -- AMD (Linux) --------------------------------------------------------------

/**
 * amdgpu surucusu VRAM'i sysfs'te bayt cinsinden bildirir; harici arac
 * gerekmez (rocm-smi kurulu olmayabilir). ROCm ikilisi yayimlanmadigi icin
 * hizlandirici Vulkan'dir -- llama.cpp'nin Linux'ta AMD icin verdigi yol.
 */
const DRM_DIR = "/sys/class/drm";

function detectAmdGpu(): GpuInfo | null {
  const card = findAmdCard();
  if (!card) return null;
  const totalBytes = readNumberFile(`${card}/device/mem_info_vram_total`);
  if (totalBytes === null || totalBytes <= 0) return null;
  return {
    name: readAmdName(card),
    vendor: "amd",
    vramTotalMb: Math.floor(totalBytes / MB),
    accelerator: "Vulkan",
  };
}

function findAmdCard(): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(DRM_DIR);
  } catch {
    return null;
  }
  for (const entry of entries.filter((name) => /^card\d+$/.test(name)).sort()) {
    const card = `${DRM_DIR}/${entry}`;
    if (fs.existsSync(`${card}/device/mem_info_vram_total`)) return card;
  }
  return null;
}

function readAmdName(card: string): string {
  // `product_name` her surucude yok; yoksa PCI kimligiyle yetiniriz.
  const product = readTextFile(`${card}/device/product_name`);
  if (product) return product;
  const device = readTextFile(`${card}/device/device`);
  return device ? `AMD GPU (${device})` : "AMD GPU";
}

// -- Windows (NVIDIA disi) ----------------------------------------------------

function detectWindowsGpu(): GpuInfo | null {
  const output = runQuiet("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object -First 1 | " +
      'ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }',
  ]);
  const parsed = parseWindowsGpu(output);
  if (!parsed) return null;
  const vendor = /radeon|amd/i.test(parsed.name)
    ? "amd"
    : /intel|arc/i.test(parsed.name)
      ? "intel"
      : "unknown";
  return {
    name: parsed.name,
    vendor,
    vramTotalMb: parsed.vramTotalMb,
    // VRAM olcemedigimizde katman bolmek kumar olur; Vulkan diyip 0 VRAM
    // vermek butceye "CPU.da tut" dedirtir.
    accelerator: parsed.vramTotalMb > 0 ? "Vulkan" : "CPU",
  };
}

/**
 * `Name|AdapterRAM` ciktisini okur. AdapterRAM 32 bit imzasiz oldugu icin
 * 4 GB'ta kirpilir ve modern kartlarda yanlistir: 4095 MB ve ustunu
 * "bilinmiyor" sayariz, cunku 4 GB'lik bir butceyle 8 GB'lik karti
 * yanlis planlamak sessiz OOM demektir.
 */
export function parseWindowsGpu(
  output: string,
): { name: string; vramTotalMb: number } | null {
  const line = output.split("\n").map((l) => l.trim()).find((l) => l.includes("|"));
  if (!line) return null;
  const separator = line.lastIndexOf("|");
  const name = line.slice(0, separator).trim();
  const bytes = Number.parseInt(line.slice(separator + 1).trim(), 10);
  if (!name) return null;
  const megabytes = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / MB) : 0;
  return { name, vramTotalMb: megabytes >= 4095 ? 0 : megabytes };
}

// -- VRAM kullanimi -----------------------------------------------------------

const VRAM_CACHE_MS = 1000;
let vramCache: { used: number; at: number } | null = null;

/**
 * Su an dolu olan VRAM. Surucu genelinde olculur (baska uygulamalar dahil):
 * model yerlestirirken onemli olan gercekten bos olan yerdir.
 */
export function getVramUsedMb(): number {
  const now = Date.now();
  if (vramCache && now - vramCache.at < VRAM_CACHE_MS) return vramCache.used;

  const gpu = getGpuInfo();
  let used = 0;
  if (gpu.vendor === "nvidia") {
    const parsed = parseNvidiaSmi(runQuiet("nvidia-smi", NVIDIA_QUERY));
    if (parsed) used = Math.max(0, parsed.vramTotalMb - parsed.vramFreeMb);
  } else if (gpu.vendor === "amd" && os.platform() === "linux") {
    const card = findAmdCard();
    const bytes = card ? readNumberFile(`${card}/device/mem_info_vram_used`) : null;
    if (bytes !== null) used = Math.floor(bytes / MB);
  }

  vramCache = { used, at: now };
  return used;
}

// -- Bellek ------------------------------------------------------------------

/**
 * Gercekten kullanilabilir bellek.
 *
 * macOS'ta os.freemem() yalnizca "free" sayfalari sayar; onbelleklenmis ama
 * geri alinabilir sayfalari saymaz, bu yuzden 16 GB'lik bir makinede surekli
 * ~0.5 GB gosterir. Linux'ta ayni sorun var: cekirdek bos RAM'i disk
 * onbellegine verir ve os.freemem() onu bos saymaz -- /proc/meminfo'daki
 * MemAvailable tam olarak "geri alinabilir" olani bildirir. Windows'ta
 * os.freemem() zaten dogru sayidir.
 */
const AVAILABLE_CACHE_MS = 1000;
let availableCache: { value: number; at: number } | null = null;

export function getAvailableMemoryMb(): number {
  const now = Date.now();
  if (availableCache && now - availableCache.at < AVAILABLE_CACHE_MS) {
    return availableCache.value;
  }
  const fallback = Math.floor(os.freemem() / MB);
  const value =
    os.platform() === "darwin"
      ? (readMacAvailableMb() ?? fallback)
      : os.platform() === "linux"
        ? (readLinuxAvailableMb() ?? fallback)
        : fallback;
  availableCache = { value, at: now };
  return value;
}

function readMacAvailableMb(): number | null {
  const output = runQuiet("vm_stat", []);
  if (!output) return null;
  return parseVmStatAvailableMb(output, sysctlNumber("hw.pagesize") || 4096);
}

function readLinuxAvailableMb(): number | null {
  const output = readTextFile("/proc/meminfo");
  return output ? parseMemAvailableMb(output) : null;
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

/** /proc/meminfo: `MemAvailable:   12345678 kB`. */
export function parseMemAvailableMb(output: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(output);
  if (!match?.[1]) return null;
  const kilobytes = Number.parseInt(match[1], 10);
  return Number.isFinite(kilobytes) ? Math.floor(kilobytes / 1024) : null;
}

// -- Cekirdek sayisi ----------------------------------------------------------

let physicalCoreCache: number | null = null;

export function getPhysicalCores(): number {
  if (physicalCoreCache !== null) return physicalCoreCache;
  physicalCoreCache = detectPhysicalCores();
  return physicalCoreCache;
}

function detectPhysicalCores(): number {
  const fallback = Math.max(1, Math.floor(os.cpus().length / 2));
  switch (os.platform()) {
    case "darwin": {
      const value = sysctlNumber("hw.physicalcpu");
      return value > 0 ? value : fallback;
    }
    case "linux": {
      const text = readTextFile("/proc/cpuinfo");
      return (text ? parseCpuinfoPhysicalCores(text) : null) ?? fallback;
    }
    case "win32": {
      const output = runQuiet("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum",
      ]);
      const value = Number.parseInt(output.trim(), 10);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    }
    default:
      return fallback;
  }
}

/**
 * /proc/cpuinfo'da her mantiksal cekirdek bir blok. Fiziksel cekirdek sayisi
 * (physical id, core id) ikililerinin tekil sayisidir; alanlar yoksa
 * (ARM SBC'ler bunlari yazmaz) "cpu cores" satirina, o da yoksa null'a duseriz.
 */
export function parseCpuinfoPhysicalCores(output: string): number | null {
  const pairs = new Set<string>();
  let physicalId = "";
  for (const line of output.split("\n")) {
    const [rawKey, rawValue] = line.split(":");
    if (rawValue === undefined) continue;
    const key = rawKey?.trim();
    const value = rawValue.trim();
    if (key === "physical id") physicalId = value;
    else if (key === "core id") pairs.add(`${physicalId}/${value}`);
  }
  if (pairs.size > 0) return pairs.size;

  const cores = /^cpu cores\s*:\s*(\d+)/m.exec(output);
  if (cores?.[1]) {
    const value = Number.parseInt(cores[1], 10);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
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
  const gpu = getGpuInfo();
  return {
    cpuUsagePercent: getCpuUsagePercent(),
    memoryUsedMb: Math.max(0, totalMb - getAvailableMemoryMb()),
    memoryTotalMb: totalMb,
    // Birlesik bellekte "VRAM kullanimi" ayri bir sayi degil; ayrik kartta
    // surucuden gercek deger okunur.
    vramUsedMb: gpu.vendor === "apple" ? 0 : getVramUsedMb(),
    vramTotalMb: gpu.vramTotalMb,
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

function readTextFile(target: string): string {
  try {
    return fs.readFileSync(target, "utf8").trim();
  } catch {
    return "";
  }
}

function readNumberFile(target: string): number | null {
  const value = Number.parseInt(readTextFile(target), 10);
  return Number.isFinite(value) ? value : null;
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
