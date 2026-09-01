import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PathEscapeError, resolveInside } from "../src/security/paths.js";

let root: string;
let outside: string;

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "studio-paths-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(root, "sub"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(root, "sub", "ok.txt"), "ok");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
});

afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("resolveInside", () => {
  it("kok icindeki yolu cozer", () => {
    expect(resolveInside(root, "sub/ok.txt")).toBe(
      fs.realpathSync(path.join(root, "sub", "ok.txt")),
    );
  });

  it("bas egik cizgiyi koke gore yorumlar", () => {
    expect(resolveInside(root, "/sub/ok.txt")).toBe(
      fs.realpathSync(path.join(root, "sub", "ok.txt")),
    );
  });

  it("..  ile kacisi reddeder", () => {
    expect(() => resolveInside(root, "../outside/secret.txt")).toThrow(
      PathEscapeError,
    );
    expect(() => resolveInside(root, "sub/../../outside/secret.txt")).toThrow(
      PathEscapeError,
    );
    expect(() => resolveInside(root, "/../../../../etc/passwd")).toThrow(
      PathEscapeError,
    );
  });

  it("kodlanmis kacis dizilerini reddeder", () => {
    // Cagiran taraf decode ettikten sonra da ayni sonucu vermeli.
    expect(() => resolveInside(root, decodeURIComponent("%2e%2e%2fsecret"))).toThrow(
      PathEscapeError,
    );
  });

  it("kok disina isaret eden sembolik bagi reddeder", () => {
    // "junction": Windows'ta yonetici yetkisi gerektirmeyen dizin bagi.
    fs.symlinkSync(outside, path.join(root, "escape-link"), "junction");
    expect(() => resolveInside(root, "escape-link/secret.txt")).toThrow(
      PathEscapeError,
    );
  });

  it("henuz var olmayan ama kok icindeki yola izin verir", () => {
    const target = resolveInside(root, "sub/yeni-dosya.txt");
    expect(target.startsWith(fs.realpathSync(root))).toBe(true);
  });
});
