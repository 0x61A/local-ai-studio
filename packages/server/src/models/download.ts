import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveInside } from "../security/paths.js";

/**
 * Model indirme yöneticisi.
 *
 * Referans projedeki üç eksiği kapatır:
 *  - Devam etme yok: `.part` dosyası başta siliniyordu, kesilen 6 GB'lık
 *    indirme baştan başlıyordu. Burada HTTP Range ile kaldığı yerden devam.
 *  - Saglama toplamı yok: indirilen dosya doğrulanmadan motora veriliyordu.
 *  - Tek kuyruk: aynı anda tek indirme; burada sınırlı paralellik var.
 *
 * Ayrıca konak beyaz listesi var: keyfi URL indirmek sürükle-bırak indirme
 * ve tedarik zinciri riski demekti.
 */

const ALLOWED_HOSTS = new Set([
  "huggingface.co",
  "cdn-lfs.huggingface.co",
  "cdn-lfs-us-1.huggingface.co",
  "cdn-lfs-eu-1.huggingface.co",
  "transfer.xethub.hf.co",
  "civitai.com",
]);

const MAX_PARALLEL = 2;
const PROGRESS_INTERVAL_MS = 500;

export type DownloadState =
  | "queued"
  | "downloading"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface DownloadTask {
  id: string;
  filename: string;
  url: string;
  targetDir: string;
  expectedSha256: string | null;
  state: DownloadState;
  totalBytes: number;
  downloadedBytes: number;
  bytesPerSecond: number;
  etaSeconds: number;
  error: string | null;
  /** Kesilmiş bir indirmeden devam edildi mi. */
  resumed: boolean;
}

interface ActiveTask extends DownloadTask {
  controller: AbortController;
}

export class DownloadError extends Error {}

export interface DownloadManagerOptions {
  /**
   * URL politikası. Varsayılan katı beyaz listedir; yalnızca testler
   * yerel sunucuya izin vermek için değiştirir. Üretimde geçersiz kılmayın.
   */
  allowUrl?: (url: string) => void;
}

export class DownloadManager {
  private readonly tasks = new Map<string, ActiveTask>();
  private running = 0;
  private readonly allowUrl: (url: string) => void;

  constructor(options: DownloadManagerOptions = {}) {
    this.allowUrl = options.allowUrl ?? ((url) => void assertAllowedUrl(url));
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()].map(stripInternals);
  }

  get(id: string): DownloadTask | null {
    const task = this.tasks.get(id);
    return task ? stripInternals(task) : null;
  }

  /** Biten ve hata alan kayıtları listeden temizler. */
  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.state === "done" || task.state === "error" || task.state === "cancelled") {
        this.tasks.delete(id);
      }
    }
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (task.state === "done") return false;
    task.controller.abort();
    task.state = "cancelled";
    return true;
  }

  enqueue(spec: {
    url: string;
    filename: string;
    targetDir: string;
    expectedSha256?: string | null;
  }): DownloadTask {
    this.allowUrl(spec.url);
    const filename = safeFilename(spec.filename);

    const existing = [...this.tasks.values()].find(
      (task) =>
        task.filename === filename &&
        task.targetDir === spec.targetDir &&
        (task.state === "queued" || task.state === "downloading"),
    );
    if (existing) return stripInternals(existing);

    const task: ActiveTask = {
      id: crypto.randomUUID(),
      filename,
      url: spec.url,
      targetDir: spec.targetDir,
      expectedSha256: spec.expectedSha256 ?? null,
      state: "queued",
      totalBytes: 0,
      downloadedBytes: 0,
      bytesPerSecond: 0,
      etaSeconds: 0,
      error: null,
      resumed: false,
      controller: new AbortController(),
    };
    this.tasks.set(task.id, task);
    void this.pump();
    return stripInternals(task);
  }

  private async pump(): Promise<void> {
    if (this.running >= MAX_PARALLEL) return;
    const next = [...this.tasks.values()].find((task) => task.state === "queued");
    if (!next) return;

    this.running += 1;
    next.state = "downloading";
    try {
      await this.run(next);
      if (next.state === "downloading" || next.state === "verifying") {
        next.state = "done";
      }
    } catch (err) {
      // İptal durumunun kaynağı sinyaldir; durum alanı geri çağrılarla
      // değişebildiği için ona güvenmiyoruz.
      if (next.controller.signal.aborted) {
        next.state = "cancelled";
      } else {
        next.state = "error";
        next.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.running -= 1;
      void this.pump();
    }
  }

  private async run(task: ActiveTask): Promise<void> {
    await fsp.mkdir(task.targetDir, { recursive: true });
    const destination = resolveInside(task.targetDir, task.filename);
    const partial = `${destination}.part`;

    let startAt = 0;
    const hash = crypto.createHash("sha256");
    if (fs.existsSync(partial)) {
      // Devam: mevcut baytları hash'e besleyip nereden devam edeceğimizi buluruz.
      startAt = await feedExisting(partial, hash);
      task.resumed = startAt > 0;
      task.downloadedBytes = startAt;
    }

    const response = await fetch(task.url, {
      headers: startAt > 0 ? { range: `bytes=${startAt}-` } : {},
      signal: task.controller.signal,
      redirect: "follow",
    });

    if (!response.ok || !response.body) {
      throw new DownloadError(describeHttpError(response.status, task.url));
    }
    // Sunucu Range'i yok saydıysa baştan başlarız.
    if (startAt > 0 && response.status !== 206) {
      startAt = 0;
      task.resumed = false;
      task.downloadedBytes = 0;
      await fsp.rm(partial, { force: true });
      return this.run(task);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    task.totalBytes = startAt + (Number.isFinite(contentLength) ? contentLength : 0);

    const file = fs.createWriteStream(partial, { flags: startAt > 0 ? "a" : "w" });
    let lastTick = Date.now();
    let lastBytes = task.downloadedBytes;

    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      task.downloadedBytes += chunk.length;
      const now = Date.now();
      if (now - lastTick >= PROGRESS_INTERVAL_MS) {
        const seconds = (now - lastTick) / 1000;
        task.bytesPerSecond = Math.round((task.downloadedBytes - lastBytes) / seconds);
        task.etaSeconds =
          task.bytesPerSecond > 0 && task.totalBytes > 0
            ? Math.max(0, Math.round((task.totalBytes - task.downloadedBytes) / task.bytesPerSecond))
            : 0;
        lastTick = now;
        lastBytes = task.downloadedBytes;
      }
    });

    try {
      await pipeline(source, file);
    } catch (err) {
      if (task.controller.signal.aborted) {
        // Yarım dosya bilerek bırakılır: sonraki denemede devam edilir.
        throw new DownloadError("İndirme iptal edildi.");
      }
      throw err;
    }

    if (task.expectedSha256) {
      task.state = "verifying";
      const actual = hash.digest("hex");
      if (actual !== task.expectedSha256.toLowerCase()) {
        await fsp.rm(partial, { force: true });
        throw new DownloadError(
          `SHA256 doğrulaması başarısız: dosya bozuk veya değiştirilmiş. ` +
            `Beklenen ${task.expectedSha256.slice(0, 16)}…, bulunan ${actual.slice(0, 16)}…`,
        );
      }
    }

    await fsp.rename(partial, destination);
  }
}

// -- Yardımcılar --------------------------------------------------------------

export function assertAllowedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DownloadError("Geçersiz indirme adresi.");
  }
  if (url.protocol !== "https:") {
    throw new DownloadError("Yalnızca HTTPS adreslerinden indirilir.");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    ALLOWED_HOSTS.has(host) ||
    host.endsWith(".hf.co") ||
    host.endsWith(".huggingface.co");
  if (!allowed) {
    throw new DownloadError(
      `Bu konaktan indirmeye izin verilmiyor: ${host}. ` +
        `İzinli konaklar: Hugging Face, Civitai.`,
    );
  }
  return url;
}

/**
 * Dosya adını doğrular.
 *
 * Bilerek "temizlemez", reddeder: "../../etc/passwd" girdisini sessizce
 * "passwd"a çevirmek saldırıyı gizler ve model dizinindeki alakasız bir
 * dosyanın üzerine yazabilir. Yol ayırıcısı içeren bir model adı hiçbir
 * zaman meşru değildir.
 */
export function safeFilename(raw: string): string {
  const name = raw.trim();
  if (!name || name === "." || name === "..") {
    throw new DownloadError(`Geçersiz dosya adı: ${raw}`);
  }
  if (/[/\\]/.test(name) || name.includes("\0")) {
    throw new DownloadError(`Dosya adı yol ayırıcısı içeremez: ${raw}`);
  }
  if (name.startsWith(".")) {
    throw new DownloadError(`Gizli dosya adı kabul edilmiyor: ${raw}`);
  }
  if (name !== path.basename(name)) {
    throw new DownloadError(`Geçersiz dosya adı: ${raw}`);
  }
  return name;
}

/** Yarım dosyayı hash'e besler ve kaç bayttan devam edileceğini döner. */
async function feedExisting(partial: string, hash: crypto.Hash): Promise<number> {
  const stats = await fsp.stat(partial);
  if (stats.size === 0) return 0;
  for await (const chunk of fs.createReadStream(partial)) {
    hash.update(chunk as Buffer);
  }
  return stats.size;
}

function describeHttpError(status: number, url: string): string {
  if (status === 401 || status === 403) {
    return `HTTP ${status}: Bu model erişim izni gerektiriyor. Model sayfasını tarayıcıda açıp koşulları kabul edin.`;
  }
  if (status === 404) return `HTTP 404: Dosya bulunamadı (${new URL(url).pathname}).`;
  if (status === 416) return "HTTP 416: Yarım dosya sunucudakiyle uyuşmuyor; yeniden indirin.";
  if (status === 429) return "HTTP 429: Çok fazla istek; biraz bekleyip tekrar deneyin.";
  return `HTTP ${status}: İndirme başarısız.`;
}

function stripInternals(task: ActiveTask): DownloadTask {
  const { controller: _controller, ...rest } = task;
  return { ...rest };
}

export const downloads = new DownloadManager();
