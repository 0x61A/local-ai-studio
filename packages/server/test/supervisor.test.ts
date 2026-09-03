import { describe, expect, it } from "vitest";
import {
  Engine,
  describeExit,
  findFreePort,
  httpProbe,
} from "../src/engines/supervisor.js";

/** Verilen portta HTTP sunucusu açan sahte motor. */
const FAKE_ENGINE = `
const http = require("node:http");
const port = Number(process.argv[1]);
const delay = Number(process.argv[2] || 0);
setTimeout(() => {
  http.createServer((req, res) => { res.writeHead(200); res.end("ok"); }).listen(port, "127.0.0.1");
  console.log("sahte motor dinliyor " + port);
}, delay);
setInterval(() => {}, 1000);
`;

/** Hemen hata ile çıkan sahte motor. */
const FAILING_ENGINE = `
console.error("error: model dosyasi okunamadi");
process.exit(1);
`;

function spec(script: string, extraArgs: string[] = [], overrides = {}) {
  return {
    binary: process.execPath,
    args: (port: number) => ["-e", script, "--", String(port), ...extraArgs],
    model: "sahte-model",
    footprintMb: 128,
    preferredPort: 18400 + Math.floor(Math.random() * 400),
    probe: (port: number) => httpProbe(`http://127.0.0.1:${port}/`, 500),
    readyTimeoutMs: 15_000,
    ...overrides,
  };
}

describe("Engine yaşam döngüsü", () => {
  it("süreci başlatır ve hazır olana kadar bekler", async () => {
    const engine = new Engine("test");
    const status = await engine.start(spec(FAKE_ENGINE));
    try {
      expect(status.state).toBe("ready");
      expect(status.port).toBeGreaterThan(0);
      expect(status.model).toBe("sahte-model");
      expect(engine.baseUrl()).toBe(`http://127.0.0.1:${status.port}`);
      expect(await httpProbe(`${engine.baseUrl()}/`)).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("durdurunca süreci gerçekten sonlandırır", async () => {
    const engine = new Engine("test");
    const started = await engine.start(spec(FAKE_ENGINE));
    const port = started.port!;
    await engine.stop();

    expect(engine.status().state).toBe("stopped");
    expect(engine.baseUrl()).toBeNull();
    expect(engine.isRunning()).toBe(false);
    // Port serbest kalmalı: süreç gerçekten öldü.
    expect(await httpProbe(`http://127.0.0.1:${port}/`, 500)).toBe(false);
  });

  it("hemen çıkan motoru anlaşılır hatayla bildirir", async () => {
    const engine = new Engine("test");
    const status = await engine.start(spec(FAILING_ENGINE, [], { readyTimeoutMs: 8000 }));
    expect(status.state).toBe("error");
    expect(status.error).toContain("hata ile çıktı");
    // Çıktıdaki asıl hata satırı da taşınmalı.
    expect(status.error).toContain("model dosyasi okunamadi");
  });

  it("hazır olmayan motoru zaman aşımıyla kapatır", async () => {
    const engine = new Engine("test");
    // Sunucuyu hiç açmayan ama yaşayan süreç.
    const status = await engine.start(
      spec("setInterval(() => {}, 1000);", [], { readyTimeoutMs: 1500 }),
    );
    expect(status.state).toBe("error");
    expect(status.error).toContain("hazır olmadı");
    expect(engine.isRunning()).toBe(false);
  });

  it("yeniden başlatınca eskisini kapatır", async () => {
    const engine = new Engine("test");
    const first = await engine.start(spec(FAKE_ENGINE));
    const firstPort = first.port!;
    const second = await engine.start(spec(FAKE_ENGINE));
    try {
      expect(second.state).toBe("ready");
      expect(await httpProbe(`http://127.0.0.1:${firstPort}/`, 500)).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("eşzamanlı başlat/durdur çağrıları sıraya girer", async () => {
    const engine = new Engine("test");
    const results = await Promise.all([
      engine.start(spec(FAKE_ENGINE)),
      engine.stop(),
      engine.start(spec(FAKE_ENGINE)),
    ]);
    try {
      // Yarış olsaydı ara durumlar tutarsız olurdu; son işlem kazanır.
      expect(results).toHaveLength(3);
      expect(engine.status().state).toBe("ready");
    } finally {
      await engine.stop();
    }
  });

  it("çalışma günlüğünün son satırlarını tutar", async () => {
    const engine = new Engine("test");
    await engine.start(spec(FAKE_ENGINE));
    try {
      expect(engine.recentLogs().join("\n")).toContain("sahte motor dinliyor");
    } finally {
      await engine.stop();
    }
  });

  it("başlatılmamış motor stopped durumundadır", () => {
    const engine = new Engine("bos");
    expect(engine.status()).toMatchObject({
      state: "stopped",
      port: null,
      error: null,
      footprintMb: 0,
    });
  });
});

describe("describeExit", () => {
  it("bilinen çıkış kodlarını açıklar", () => {
    expect(describeExit("/bin/sd", 127, null)).toContain("bulunamadı");
    expect(describeExit("/bin/sd", 126, null)).toContain("çalıştırılabilir değil");
    expect(describeExit("/bin/sd", null, "SIGKILL")).toContain("bellek yetersizliği");
    expect(describeExit("/bin/sd", 139, null)).toContain("Bellek erişim hatası");
  });

  it("günlükten yalnızca ilgili satırları ekler", () => {
    const message = describeExit("/bin/x", 1, null, [
      "yükleniyor katman 1",
      "error: unsupported architecture",
      "yükleniyor katman 2",
    ]);
    expect(message).toContain("unsupported architecture");
    expect(message).not.toContain("katman 1");
  });

  it("ikili dosyanın yalnızca adını gösterir", () => {
    expect(describeExit("/uzun/yol/llama-server", 1, null)).toContain("llama-server");
    expect(describeExit("/uzun/yol/llama-server", 1, null)).not.toContain("/uzun/yol");
  });
});

describe("findFreePort", () => {
  it("boş port bulur", async () => {
    const port = await findFreePort(18900);
    expect(port).toBeGreaterThanOrEqual(18900);
    expect(await httpProbe(`http://127.0.0.1:${port}/`, 300)).toBe(false);
  });

  it("meşgul portu atlar", async () => {
    const net = await import("node:net");
    const busy = 18950;
    const blocker = net.createServer().listen(busy, "127.0.0.1");
    await new Promise((resolve) => blocker.once("listening", resolve));
    try {
      expect(await findFreePort(busy, 5)).toBeGreaterThan(busy);
    } finally {
      blocker.close();
    }
  });
});

describe("yetim süreç toplama", () => {
  it("kendi ikilimizi çalıştırmayan kimliği öldürmez", async () => {
    const { reapOrphans } = await import("../src/engines/supervisor.js");
    const fs = await import("node:fs");
    const { ENGINE_PID_FILE } = await import("../src/config.js");
    // data/ depoda yok (gitignore). Baska bir testin onu olusturmus olmasina
    // guvenmek testi siraya bagli yapiyordu: Windows'ta sira degisince ENOENT.
    const nodePath = await import("node:path");
    fs.mkdirSync(nodePath.dirname(ENGINE_PID_FILE), { recursive: true });

    // Bu sürecin kendi kimliği: bizim "motor ikilimiz" değil, bu yüzden
    // dokunulmamalı. Kör öldürme burada patlardı.
    fs.writeFileSync(
      ENGINE_PID_FILE,
      JSON.stringify({ sahte: { pid: process.pid, binary: "/olmayan/motor-ikili" } }),
    );
    expect(reapOrphans()).toBe(0);
    // Hâlâ yaşıyoruz.
    expect(process.kill(process.pid, 0)).toBe(true);
    fs.rmSync(ENGINE_PID_FILE, { force: true });
  });

  it("var olmayan kimliği sessizce atlar", async () => {
    const { reapOrphans } = await import("../src/engines/supervisor.js");
    const fs = await import("node:fs");
    const { ENGINE_PID_FILE } = await import("../src/config.js");
    // data/ depoda yok (gitignore). Baska bir testin onu olusturmus olmasina
    // guvenmek testi siraya bagli yapiyordu: Windows'ta sira degisince ENOENT.
    const nodePath = await import("node:path");
    fs.mkdirSync(nodePath.dirname(ENGINE_PID_FILE), { recursive: true });
    fs.writeFileSync(
      ENGINE_PID_FILE,
      JSON.stringify({ eski: { pid: 999999, binary: "/bin/whatever" } }),
    );
    expect(reapOrphans()).toBe(0);
    fs.rmSync(ENGINE_PID_FILE, { force: true });
  });

  it("gerçekten kendi başlattığımız süreci toplar", async () => {
    const { reapOrphans } = await import("../src/engines/supervisor.js");
    const fs = await import("node:fs");
    const { spawn } = await import("node:child_process");
    const { ENGINE_PID_FILE } = await import("../src/config.js");
    // data/ depoda yok (gitignore). Baska bir testin onu olusturmus olmasina
    // guvenmek testi siraya bagli yapiyordu: Windows'ta sira degisince ENOENT.
    const nodePath = await import("node:path");
    fs.mkdirSync(nodePath.dirname(ENGINE_PID_FILE), { recursive: true });

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(
      ENGINE_PID_FILE,
      JSON.stringify({ test: { pid: child.pid, binary: process.execPath } }),
    );

    expect(reapOrphans()).toBe(1);
    await new Promise((resolve) => child.once("exit", resolve));
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
    fs.rmSync(ENGINE_PID_FILE, { force: true });
  });
});
