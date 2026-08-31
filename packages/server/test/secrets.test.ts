import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertName,
  decryptSecret,
  encryptSecret,
  maskSecret,
  type StoredSecret,
} from "../src/security/secrets.js";

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

describe("şifreleme çekirdeği", () => {
  it("gidiş dönüş yapar", () => {
    const record = encryptSecret(KEY, "sk-proj-çok-gizli-anahtar-9f2a");
    expect(decryptSecret(KEY, record)).toBe("sk-proj-çok-gizli-anahtar-9f2a");
  });

  it("düz metni saklamaz", () => {
    const secret = "sk-proj-gizli";
    const record = encryptSecret(KEY, secret);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(Buffer.from(record.data, "base64").toString("utf8")).not.toContain(secret);
  });

  it("aynı değeri her seferinde farklı şifreler (rastgele IV)", () => {
    const a = encryptSecret(KEY, "aynı-değer");
    const b = encryptSecret(KEY, "aynı-değer");
    expect(a.data).not.toBe(b.data);
    expect(a.iv).not.toBe(b.iv);
  });

  it("yanlış anahtarla çözemez", () => {
    const record = encryptSecret(KEY, "gizli");
    expect(decryptSecret(OTHER_KEY, record)).toBeNull();
  });

  it("kurcalanmış şifreli metni reddeder (GCM etiketi)", () => {
    const record = encryptSecret(KEY, "gizli-değer-uzun");
    const bytes = Buffer.from(record.data, "base64");
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    const tampered: StoredSecret = { ...record, data: bytes.toString("base64") };
    expect(decryptSecret(KEY, tampered)).toBeNull();
  });

  it("kurcalanmış etiketi reddeder", () => {
    const record = encryptSecret(KEY, "gizli-değer-uzun");
    const tag = Buffer.from(record.tag, "base64");
    tag[0] = (tag[0]! ^ 0xff) & 0xff;
    expect(decryptSecret(KEY, { ...record, tag: tag.toString("base64") })).toBeNull();
  });

  it("bozuk kayıtta patlamaz", () => {
    expect(
      decryptSecret(KEY, { iv: "??", tag: "??", data: "??", masked: "", updatedAt: 0 }),
    ).toBeNull();
  });
});

describe("maskeleme", () => {
  it("tanımaya yeter, kullanmaya yetmez", () => {
    const masked = maskSecret("sk-proj-abcdefghijklmnop9f2a");
    expect(masked).toBe("sk-pr…9f2a");
    expect(masked).not.toContain("abcdefghij");
  });

  it("kısa değerleri tamamen gizler", () => {
    expect(maskSecret("kisa")).toBe("••••");
    expect(maskSecret("12345678")).toBe("••••••••");
  });
});

describe("sır adı doğrulama", () => {
  it("geçerli adları normalleştirir", () => {
    expect(assertName("  OpenAI  ")).toBe("openai");
    expect(assertName("google.gemini")).toBe("google.gemini");
    expect(assertName("open-router_1")).toBe("open-router_1");
  });

  it("ayar anahtarını kırabilecek adları reddeder", () => {
    for (const bad of ["", "  ", "a b", "secret:openai", "../escape", "ö", "-baslangic"]) {
      expect(() => assertName(bad), `kabul edilmemeliydi: ${bad}`).toThrow();
    }
  });
});
