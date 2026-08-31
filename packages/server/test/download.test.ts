import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DownloadError,
  DownloadManager,
  assertAllowedUrl,
  safeFilename,
} from "../src/models/download.js";

describe("konak beyaz listesi", () => {
  it("Hugging Face ve alt alan adlarına izin verir", () => {
    expect(() => assertAllowedUrl("https://huggingface.co/x/y.gguf")).not.toThrow();
    expect(() => assertAllowedUrl("https://cdn-lfs-us-1.huggingface.co/a")).not.toThrow();
    expect(() => assertAllowedUrl("https://transfer.xethub.hf.co/a")).not.toThrow();
  });

  it("yabancı konağı reddeder", () => {
    expect(() => assertAllowedUrl("https://kotu-site.example/model.gguf")).toThrow(
      DownloadError,
    );
  });

  it("alt alan adı taklidini reddeder", () => {
    // "huggingface.co.kotu.example" beyaz listeye girmemeli.
    expect(() => assertAllowedUrl("https://huggingface.co.kotu.example/a")).toThrow(
      DownloadError,
    );
  });

  it("HTTPS olmayanı reddeder", () => {
    expect(() => assertAllowedUrl("http://huggingface.co/a")).toThrow(/HTTPS/);
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow();
  });
});

describe("safeFilename", () => {
  it("düz dosya adını kabul eder", () => {
    expect(safeFilename("model.gguf")).toBe("model.gguf");
    expect(safeFilename("  Qwen2.5-0.5B-Q4_K_M.gguf  ")).toBe("Qwen2.5-0.5B-Q4_K_M.gguf");
  });

  it("yol ayırıcısı içereni reddeder", () => {
    expect(() => safeFilename("a/b/model.gguf")).toThrow(DownloadError);
  });

  it("kaçış ve gizli dosya denemelerini reddeder", () => {
    for (const bad of ["../../etc/passwd", "..", ".", ".gizli", "", "   ", "a\\b.gguf"]) {
      expect(() => safeFilename(bad), `kabul edilmemeliydi: ${bad}`).toThrow(DownloadError);
    }
  });

  it("traversal denemesini sessizce düzeltmez", () => {
    // path.basename ile "passwd"a çevirmek saldırıyı gizler ve model
    // dizinindeki başka bir dosyanın üzerine yazabilirdi.
    expect(() => safeFilename("../../etc/passwd")).toThrow(/yol ayırıcısı/);
  });
});

// -- Gerçek HTTP sunucusuyla indirme --------------------------------------

const PAYLOAD = Buffer.from("x".repeat(64 * 1024) + "SON");
const PAYLOAD_SHA = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

let server: http.Server;
let port: number;
let workDir: string;
/** Sunucu Range başlığını yok saysın mı (bazı CDN'ler yok sayar). */
let ignoreRange = false;
let requestLog: Array<string | undefined> = [];

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-dl-"));
  server = http.createServer((req, res) => {
    requestLog.push(req.headers["range"]);
    if (req.url === "/missing") {
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/gated") {
      res.writeHead(403).end();
      return;
    }
    const range = ignoreRange ? undefined : req.headers["range"];
    const match = /^bytes=(\d+)-/.exec(String(range ?? ""));
    if (match?.[1]) {
      const start = Number(match[1]);
      const slice = PAYLOAD.subarray(start);
      res.writeHead(206, {
        "content-length": slice.length,
        "content-range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "content-length": PAYLOAD.length });
    res.end(PAYLOAD);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Yerel test sunucusuna izin veren yönetici. Üretim politikası (katı beyaz
 * liste) yukarıda ayrıca test ediliyor.
 */
function testManager() {
  return new DownloadManager({
    allowUrl: (raw) => {
      const url = new URL(raw);
      if (url.hostname !== "127.0.0.1") {
        throw new Error(`test yöneticisi yalnızca loopback kabul eder: ${url.hostname}`);
      }
    },
  });
}

async function waitFor(
  check: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Beklenen durum zaman aşımına uğradı.");
}

describe("DownloadManager", () => {
  it("yarım dosyadan devam eder (HTTP Range)", async () => {
    const target = path.join(workDir, "resume");
    fs.mkdirSync(target, { recursive: true });
    const partial = path.join(target, "model.bin.part");
    const alreadyHave = 1024;
    fs.writeFileSync(partial, PAYLOAD.subarray(0, alreadyHave));

    requestLog = [];
    const manager = testManager();
    const task = manager.enqueue({
      url: `http://127.0.0.1:${port}/model.bin`,
      filename: "model.bin",
      targetDir: target,
      expectedSha256: PAYLOAD_SHA,
    });

    await waitFor(() => manager.get(task.id)?.state === "done");
    const final = manager.get(task.id)!;

    expect(final.resumed).toBe(true);
    expect(requestLog[0]).toBe(`bytes=${alreadyHave}-`);
    // Tam ve doğru dosya: hash yarım kısmı da kapsayarak doğrulandı.
    expect(fs.readFileSync(path.join(target, "model.bin"))).toEqual(PAYLOAD);
    expect(fs.existsSync(partial)).toBe(false);
  });

  it("sunucu Range'i yok sayarsa baştan indirir", async () => {
    const target = path.join(workDir, "norange");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "m.bin.part"), PAYLOAD.subarray(0, 2048));

    ignoreRange = true;
    try {
      const manager = testManager();
      const task = manager.enqueue({
        url: `http://127.0.0.1:${port}/m.bin`,
        filename: "m.bin",
        targetDir: target,
        expectedSha256: PAYLOAD_SHA,
      });
      await waitFor(() => manager.get(task.id)?.state === "done");
      // Yarım veriyi tekrar saymadan doğru dosyayı yazmalı.
      expect(fs.readFileSync(path.join(target, "m.bin"))).toEqual(PAYLOAD);
    } finally {
      ignoreRange = false;
    }
  });

  it("SHA256 uyuşmazsa dosyayı atar ve hata verir", async () => {
    const target = path.join(workDir, "badhash");
    const manager = testManager();
    const task = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: target,
      expectedSha256: "0".repeat(64),
    });
    await waitFor(() => manager.get(task.id)?.state === "error");

    const final = manager.get(task.id)!;
    expect(final.error).toContain("SHA256");
    expect(fs.existsSync(path.join(target, "m.bin"))).toBe(false);
    expect(fs.existsSync(path.join(target, "m.bin.part"))).toBe(false);
  });

  it("saglama toplamı verilmezse doğrulamayı atlar", async () => {
    const target = path.join(workDir, "nohash");
    const manager = testManager();
    const task = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: target,
    });
    await waitFor(() => manager.get(task.id)?.state === "done");
    expect(fs.existsSync(path.join(target, "m.bin"))).toBe(true);
  });

  it("404 ve 403 için anlaşılır mesaj verir", async () => {
    const manager = testManager();
    const missing = manager.enqueue({
      url: `http://127.0.0.1:${port}/missing`,
      filename: "a.bin",
      targetDir: path.join(workDir, "e1"),
    });
    const gated = manager.enqueue({
      url: `http://127.0.0.1:${port}/gated`,
      filename: "b.bin",
      targetDir: path.join(workDir, "e2"),
    });
    await waitFor(
      () =>
        manager.get(missing.id)?.state === "error" &&
        manager.get(gated.id)?.state === "error",
    );
    expect(manager.get(missing.id)?.error).toContain("bulunamadı");
    expect(manager.get(gated.id)?.error).toContain("erişim izni");
  });

  it("aynı dosyayı iki kez kuyruğa almaz", async () => {
    const target = path.join(workDir, "dupe");
    const manager = testManager();
    const first = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: target,
    });
    const second = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: target,
    });
    expect(second.id).toBe(first.id);
    await waitFor(() => manager.get(first.id)?.state === "done");
  });

  it("iptal edilen indirme yarım dosyayı bırakır (sonra devam edilsin)", async () => {
    const target = path.join(workDir, "cancel");
    const manager = testManager();
    const task = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: target,
    });
    expect(manager.cancel(task.id)).toBe(true);
    await waitFor(() => manager.get(task.id)?.state === "cancelled");
    expect(fs.existsSync(path.join(target, "m.bin"))).toBe(false);
  });

  it("biten kayıtları temizler", async () => {
    const manager = testManager();
    const task = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: path.join(workDir, "clear"),
    });
    await waitFor(() => manager.get(task.id)?.state === "done");
    manager.clearFinished();
    expect(manager.list()).toHaveLength(0);
  });

  it("toplam ve indirilen bayt sayısını bildirir", async () => {
    const manager = testManager();
    const task = manager.enqueue({
      url: `http://127.0.0.1:${port}/m.bin`,
      filename: "m.bin",
      targetDir: path.join(workDir, "bytes"),
    });
    await waitFor(() => manager.get(task.id)?.state === "done");
    const final = manager.get(task.id)!;
    expect(final.downloadedBytes).toBe(PAYLOAD.length);
    expect(final.totalBytes).toBe(PAYLOAD.length);
  });
});
