#!/usr/bin/env node
// Motor ikililerini runtime/engines/<motor> altina indirir.
//
// Uc platform tek dosyada: bash betiklerini platform basina kopyalamak
// (mac + Linux + Windows x dort motor) on iki kopya ve kacinilmaz kayma
// demekti. Node zaten kurulu -- bu betik cagrilmadan once fetch-node
// calisir -- ve indirme, SHA256 dogrulama, arsiv acma her yerde ayni.
//
// Kullanim: node fetch-engine.mjs <llama|sd|whisper|browser> [--variant cuda|vulkan|cpu]

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENGINES_DIR = path.join(ROOT, "runtime", "engines");
const IS_WINDOWS = process.platform === "win32";
const EXE = IS_WINDOWS ? ".exe" : "";

/**
 * Her motor icin: hangi depo, hangi ikili, ve platform+hizlandirici basina
 * varlik adinda aranacak kaliplar (sirayla denenir, ilk eslesen kazanir).
 * Tam ad yerine kalip: llama.cpp varlik adlarinda derleme numarasi,
 * sd.cpp'de isletim sistemi surumu geciyor.
 */
const ENGINES = {
  llama: {
    repo: "ggml-org/llama.cpp",
    binary: `llama-server${EXE}`,
    patterns: {
      "darwin-arm64": ["bin-macos-arm64"],
      "darwin-x64": ["bin-macos-x64"],
      "linux-x64": { cuda: ["bin-ubuntu-x64"], vulkan: ["bin-ubuntu-vulkan-x64", "bin-ubuntu-x64"], cpu: ["bin-ubuntu-x64"] },
      "linux-arm64": ["bin-ubuntu-arm64"],
      "win32-x64": {
        cuda: ["bin-win-cuda", "bin-win-vulkan", "bin-win-cpu-x64"],
        vulkan: ["bin-win-vulkan", "bin-win-cpu-x64"],
        cpu: ["bin-win-cpu-x64"],
      },
      "win32-arm64": ["bin-win-cpu-arm64"],
    },
    // CUDA yapisi calisma zamani DLL'lerini ayri varlikta yolluyor; onsuz
    // ikili 0xC0000135 ile aciliyor bile.
    companion: (assetName) =>
      /bin-win-cuda/i.test(assetName) ? "cudart-llama-bin-win" : null,
  },
  sd: {
    repo: "leejet/stable-diffusion.cpp",
    binary: `sd-server${EXE}`,
    patterns: {
      "darwin-arm64": ["bin-Darwin"],
      "darwin-x64": ["bin-Darwin"],
      "linux-x64": ["bin-Linux"],
      "win32-x64": {
        cuda: ["bin-win-cuda", "bin-win-vulkan", "bin-win-avx2"],
        vulkan: ["bin-win-vulkan", "bin-win-avx2"],
        cpu: ["bin-win-avx2"],
      },
    },
  },
  whisper: {
    repo: "ggml-org/whisper.cpp",
    binary: `whisper-cli${EXE}`,
    patterns: {
      "linux-x64": ["whisper-bin-ubuntu-x64"],
      "linux-arm64": ["whisper-bin-ubuntu-arm64"],
      "win32-x64": {
        cuda: ["whisper-cublas", "whisper-bin-x64"],
        vulkan: ["whisper-bin-x64"],
        cpu: ["whisper-bin-x64"],
      },
    },
    // macOS icin hazir ikili yayimlanmiyor; sisteme paket kurmayiz.
    unsupported: {
      darwin:
        "whisper.cpp macOS icin hazir ikili yayimlamiyor ve sisteminize paket kurmayiz.\n" +
        "  Uc secenek:\n" +
        "    1) Bulut: Ayarlar'dan OpenAI anahtari ekleyin, yaziya dokme orada calisir.\n" +
        "    2) Kendiniz kurun: `brew install whisper-cpp` -- PATH'te bulunca kullaniriz.\n" +
        "    3) Kaynaktan derleyip whisper-cli dosyasini runtime/engines/whisper/ altina koyun.",
    },
  },
};

async function main() {
  const [component, ...rest] = process.argv.slice(2);
  if (!component || (!ENGINES[component] && component !== "browser")) {
    fail(`Kullanim: node fetch-engine.mjs <${Object.keys(ENGINES).join("|")}|browser> [--variant cuda|vulkan|cpu]`);
  }

  const variantFlag = readFlag(rest, "--variant");
  if (component === "browser") return installBrowser();

  const engine = ENGINES[component];
  const target = path.join(ENGINES_DIR, component);
  if (isExecutable(path.join(target, engine.binary))) {
    log(component, `zaten kurulu: ${path.join(target, engine.binary)}`);
    return;
  }

  const unsupported = engine.unsupported?.[process.platform];
  if (unsupported) {
    console.error(`  [${component}] ${unsupported}`);
    process.exit(2);
  }

  const variant = variantFlag ?? detectVariant();
  const candidates = resolvePatterns(engine.patterns, variant);
  if (!candidates) {
    fail(`[${component}] bu platform icin hazir ikili yok: ${process.platform}-${process.arch}`);
  }

  log(component, `son surum araniyor (${variant}: ${candidates.join(", ")})`);
  const release = await findRelease(engine.repo, candidates);
  if (!release) fail(`[${component}] uygun varlik bulunamadi.`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "studio-engine-"));
  try {
    fs.mkdirSync(target, { recursive: true });
    await installAsset(component, release.asset, work, target);

    const companionPattern = engine.companion?.(release.asset.name);
    const companion = companionPattern
      ? release.assets.find((asset) => asset.name.includes(companionPattern))
      : null;
    if (companionPattern && !companion) {
      console.warn(`  [${component}] UYARI: ${companionPattern} varligi bulunamadi; CUDA DLL'leri eksik kalabilir.`);
    }
    if (companion) {
      log(component, `calisma zamani kutuphaneleri: ${companion.name}`);
      await installAsset(component, companion, work, target);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const binaryPath = path.join(target, engine.binary);
  if (!isExecutable(binaryPath)) {
    fail(`[${component}] ${engine.binary} arsivde bulunamadi.`);
  }
  log(component, `hazir: ${binaryPath}`);
}

// -- Varlik secimi ------------------------------------------------------------

/** Hizlandirici tespiti: hangi yapinin indirilecegini belirler. */
function detectVariant() {
  if (process.platform === "darwin") return "cpu"; // Metal zaten varsayilan yapida
  if (runQuiet("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"])) return "cuda";
  if (process.platform === "linux" && hasAmdGpu()) return "vulkan";
  if (process.platform === "win32") return "vulkan";
  return "cpu";
}

function hasAmdGpu() {
  try {
    return fs
      .readdirSync("/sys/class/drm")
      .filter((name) => /^card\d+$/.test(name))
      .some((name) => fs.existsSync(`/sys/class/drm/${name}/device/mem_info_vram_total`));
  } catch {
    return false;
  }
}

function resolvePatterns(table, variant) {
  const entry = table[`${process.platform}-${process.arch}`];
  if (!entry) return null;
  if (Array.isArray(entry)) return entry;
  return entry[variant] ?? entry.cpu ?? null;
}

/** Yeni surumden eskiye; her surumde kaliplar tercih sirasiyla denenir. */
async function findRelease(repo, candidates) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
    headers: { "user-agent": "local-ai-studio-setup" },
  });
  if (!response.ok) fail(`GitHub surum listesi alinamadi: HTTP ${response.status}`);
  const releases = await response.json();

  for (const release of releases) {
    const assets = release.assets ?? [];
    for (const pattern of candidates) {
      const asset = assets.find((item) => item.name.includes(pattern));
      if (asset) return { asset, assets };
    }
  }
  return null;
}

// -- Indirme, dogrulama, acma -------------------------------------------------

async function installAsset(component, asset, work, target) {
  const archive = path.join(work, asset.name);
  log(component, `indiriliyor: ${asset.name}`);
  await download(asset.browser_download_url, archive);

  const expected = (asset.digest ?? "").replace(/^sha256:/, "");
  if (expected) {
    const actual = sha256(archive);
    if (actual !== expected) {
      fail(`[${component}] SHA256 UYUSMUYOR. Beklenen ${expected}, bulunan ${actual}`);
    }
    log(component, "SHA256 tamam");
  } else {
    console.warn(`  [${component}] UYARI: bu varlik icin saglama toplami bildirilmemis.`);
  }

  const extracted = path.join(work, `x-${path.basename(asset.name)}`);
  fs.mkdirSync(extracted, { recursive: true });
  extract(archive, extracted);
  copyPayload(extracted, target);
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "local-ai-studio-setup" } });
  if (!response.ok || !response.body) fail(`Indirme basarisiz: HTTP ${response.status}`);
  const handle = await fs.promises.open(destination, "w");
  try {
    for await (const chunk of response.body) await handle.write(chunk);
  } finally {
    await handle.close();
  }
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

/**
 * GNU tar zip acamaz, o yuzden Linux'ta unzip kullanilir. macOS ve Windows'un
 * tar'i bsdtar; zip'i de acar, dolayisiyla oralarda ek arac gerekmez.
 */
function extract(archive, into) {
  if (archive.endsWith(".tar.gz") || archive.endsWith(".tgz")) {
    execFileSync("tar", ["-xzf", archive, "-C", into], { stdio: "inherit" });
    return;
  }
  if (archive.endsWith(".zip")) {
    if (process.platform === "linux") execFileSync("unzip", ["-q", archive, "-d", into], { stdio: "inherit" });
    else execFileSync("tar", ["-xf", archive, "-C", into], { stdio: "inherit" });
    return;
  }
  fail(`Bilinmeyen arsiv bicimi: ${path.basename(archive)}`);
}

/**
 * Arsiv duzeni surume gore degisiyor: kimi zaman ikililer kokte, kimi zaman
 * `bin/` + `lib/` ayriminda, kimi zaman tek bir `llama-xxx/` klasorunde.
 * Ikili nerede duruyorsa YANINDAKI her sey onunla birlikte tasinmali:
 * kutuphaneler rpath ile komsu dizinde araniyor ve sembolik baglar
 * korunmazsa dyld/ld cokuyor.
 */
function copyPayload(extracted, target) {
  const source = findBinaryDir(extracted) ?? extracted;
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });

  // bin/ + lib/ duzeni: kutuphaneleri ikililerin yanina getir.
  for (const folder of ["bin", "lib"]) {
    const nested = path.join(target, folder);
    if (fs.existsSync(nested)) {
      fs.cpSync(nested, target, { recursive: true, verbatimSymlinks: true });
      fs.rmSync(nested, { recursive: true, force: true });
    }
  }

  if (!IS_WINDOWS) {
    for (const name of fs.readdirSync(target)) {
      const file = path.join(target, name);
      if (fs.statSync(file).isFile() && !path.extname(name)) fs.chmodSync(file, 0o755);
    }
  }
}

/** Ikilinin bulundugu dizini arar; iki seviye yeterli, arsivler sig. */
function findBinaryDir(root, depth = 0) {
  if (depth > 3) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const hasBinary = entries.some(
    (entry) => entry.isFile() && /^(llama-server|sd-server|whisper-cli|main)(\.exe)?$/.test(entry.name),
  );
  if (hasBinary) return root;
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const found = findBinaryDir(path.join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

// -- Tarayici otomasyonu (Playwright) ----------------------------------------

/**
 * Playwright pakete gomulmez: playwright-core 2 MB ama yanindaki Chromium
 * ~150 MB. Kendi package.json'i altinda, sisteme degil runtime/ altina kurulur.
 */
function installBrowser() {
  const target = path.join(ENGINES_DIR, "playwright");
  const core = path.join(target, "node_modules", "playwright-core");
  const browsers = path.join(target, "browsers");

  if (fs.existsSync(core) && fs.existsSync(browsers)) {
    log("browser", `zaten kurulu: ${target}`);
    return;
  }

  const npm = portableNpm();
  fs.mkdirSync(target, { recursive: true });
  const manifest = path.join(target, "package.json");
  if (!fs.existsSync(manifest)) {
    fs.writeFileSync(manifest, '{\n  "name": "studio-playwright",\n  "private": true\n}\n');
  }

  log("browser", "playwright-core kuruluyor...");
  execFileSync(npm, ["install", "--no-audit", "--no-fund", "--loglevel=error", "playwright-core"], {
    cwd: target,
    stdio: "inherit",
    shell: IS_WINDOWS,
  });

  log("browser", "Chromium indiriliyor (~150 MB)...");
  execFileSync(process.execPath, [path.join(core, "cli.js"), "install", "chromium"], {
    cwd: target,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });

  log("browser", `hazir: ${target}`);
}

/** Once tasinabilir Node'un npm'i; sistemde npm olmasi gerekmiyor. */
function portableNpm() {
  const bundled = IS_WINDOWS
    ? path.join(ROOT, "runtime", "node", "npm.cmd")
    : path.join(ROOT, "runtime", "node", "bin", "npm");
  return fs.existsSync(bundled) ? bundled : IS_WINDOWS ? "npm.cmd" : "npm";
}

// -- Yardimcilar --------------------------------------------------------------

function readFlag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function isExecutable(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function runQuiet(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function log(component, message) {
  console.log(`  [${component}] ${message}`);
}

function fail(message) {
  console.error(`  ${message}`);
  process.exit(1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
