import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStudioServer, type StudioServer } from "../src/app.js";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let studio: StudioServer;
let base: string;
let webDist: string;
let secretDir: string;

beforeAll(async () => {
  webDist = fs.mkdtempSync(path.join(os.tmpdir(), "studio-dist-"));
  fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>ok</title>");
  // dist'in kardesi: buradaki dosya hicbir istekle servis edilmemeli.
  secretDir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-secret-"));
  fs.writeFileSync(path.join(secretDir, "secret.txt"), "gizli-icerik");

  studio = await startStudioServer({ token: TOKEN, webDist }, 7690);
  base = `http://127.0.0.1:${studio.port}`;
});

afterAll(async () => {
  await studio.close();
  fs.rmSync(webDist, { recursive: true, force: true });
  fs.rmSync(secretDir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe("kimlik dogrulama", () => {
  it("token'siz veri ucunu 401 ile reddeder", async () => {
    const res = await fetch(`${base}/api/system`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("yanlis token'i 401 ile reddeder", async () => {
    const res = await fetch(`${base}/api/system`, {
      headers: { authorization: "Bearer yanlis-token-aaaaaaaaaaaaaaaaaaaaaa" },
    });
    expect(res.status).toBe(401);
  });

  it("dogru token ile sistem bilgisini verir", async () => {
    const res = await fetch(`${base}/api/system`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cpu: { logicalCores: number } };
    expect(body.cpu.logicalCores).toBeGreaterThan(0);
  });

  it("/api/ping token istemez", async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.status).toBe(200);
  });
});

describe("capraz kaynak korumasi", () => {
  it("yabanci Origin'i 403 ile reddeder", async () => {
    const res = await fetch(`${base}/api/system`, {
      headers: { ...auth, origin: "https://kotu-site.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_origin");
  });

  it("Sec-Fetch-Site: cross-site istegini reddeder", async () => {
    const res = await fetch(`${base}/api/system`, {
      headers: { ...auth, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("DNS rebinding icin loopback disi Host'u reddeder", async () => {
    // fetch() Host'u degistirtmez (yasakli baslik); ham soket kullaniyoruz.
    const raw = await rawRequest(studio.port, "GET /api/system HTTP/1.1", {
      host: "kotu-site.example",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
    expect(raw).toContain("bad_host");
  });

  it("loopback Host'u kabul eder", async () => {
    const raw = await rawRequest(studio.port, "GET /api/ping HTTP/1.1", {
      host: `localhost:${studio.port}`,
    });
    expect(raw).toMatch(/^HTTP\/1\.1 200/);
  });

  it("hicbir yanitta CORS basligi gondermez", async () => {
    const res = await fetch(`${base}/api/ping`);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("statik servis", () => {
  it("kabugu servis eder", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<!doctype html>");
  });

  it("bilinmeyen yolda SPA kabuguna duser", async () => {
    const res = await fetch(`${base}/chat/olmayan`);
    expect(res.status).toBe(200);
  });

  it("duz ../ traversal kok disina hicbir sey sizdirmaz", async () => {
    // fetch() yolu normalize eder; ham istegi soket uzerinden gondeririz.
    // URL ayristiricisi "/../../etc/passwd" -> "/etc/passwd" yapar; dist
    // altinda boyle bir dosya olmadigi icin SPA kabuguna duser.
    const raw = await rawRequest(studio.port, "GET /../../../../etc/passwd HTTP/1.1");
    expect(raw).not.toContain("root:");
    expect(raw).toContain("<!doctype html>");
  });

  it("kodlanmis egik cizgili traversal denemesini 403 ile reddeder", async () => {
    // "%2f" URL normalizasyonundan sag cikar; engel resolveInside()'dir.
    const raw = await rawRequest(studio.port, "GET /..%2f..%2f..%2fetc%2fpasswd HTTP/1.1");
    expect(raw).toMatch(/^HTTP\/1\.1 403/);
    expect(raw).toContain("path_escape");
    expect(raw).not.toContain("root:");
  });

  it("dist disindaki gercek bir dosyayi kodlanmis yolla veremez", async () => {
    const escape = encodeURIComponent(path.join("..", path.basename(secretDir), "secret.txt"));
    const raw = await rawRequest(studio.port, `GET /${escape} HTTP/1.1`);
    expect(raw).not.toContain("gizli-icerik");
  });
});

describe("bilinmeyen API ucu", () => {
  it("404 doner", async () => {
    const res = await fetch(`${base}/api/olmayan-uc`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

/**
 * Ham HTTP istegi. fetch() yolu normalize eder ve Host gibi yasakli
 * basliklari degistirtmez; guvenlik testleri icin sokete iniyoruz.
 */
async function rawRequest(
  port: number,
  requestLine: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const net = await import("node:net");
  const all = { host: `127.0.0.1:${port}`, connection: "close", ...headers };
  const headerLines = Object.entries(all)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${requestLine}\r\n${headerLines}\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}
