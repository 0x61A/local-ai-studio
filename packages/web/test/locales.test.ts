import { describe, expect, it } from "vitest";
import en from "../src/locales/en.json";
import tr from "../src/locales/tr.json";

/** İç içe katalogu "a.b.c" biçiminde düz anahtar listesine indirger. */
function flatten(catalog: unknown, prefix = ""): string[] {
  if (typeof catalog !== "object" || catalog === null) return [];
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null
      ? flatten(value, path)
      : [path];
  });
}

function values(catalog: unknown, prefix = ""): Array<[string, string]> {
  if (typeof catalog !== "object" || catalog === null) return [];
  return Object.entries(catalog).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null
      ? values(value, path)
      : ([[path, String(value)]] as Array<[string, string]>);
  });
}

const trKeys = flatten(tr).sort();
const enKeys = flatten(en).sort();

describe("çeviri katalogları", () => {
  it("aynı anahtar kümesine sahip", () => {
    expect(trKeys).toEqual(enKeys);
  });

  it("hiçbir değer boş değil", () => {
    for (const [key, value] of [...values(tr), ...values(en)]) {
      expect(value.trim(), `boş çeviri: ${key}`).not.toBe("");
    }
  });

  it("yer tutucular iki dilde eşleşiyor", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    const enMap = new Map(values(en));
    for (const [key, trText] of values(tr)) {
      const enText = enMap.get(key) ?? "";
      expect(placeholders(trText), `yer tutucu uyuşmazlığı: ${key}`).toEqual(
        placeholders(enText),
      );
    }
  });

  it("Türkçe katalogda diakritik kullanılıyor", () => {
    // Eski projenin hatası: Türkçe metinler ASCII'ye düşürülmüştü
    // ("Ayarlar Kaydedildi ve Uygulandi"). Bu test onu geri gelmekten alıkoyar.
    const text = values(tr)
      .map(([, value]) => value)
      .join(" ");
    expect(text).toMatch(/[çğıöşüÇĞİÖŞÜ]/);
  });

  it("Türkçe katalogda diakritiksiz yaygın yazımlar kalmamış", () => {
    const banned = [
      "Isletim", "Islemci", "Hizlandirma", "butcesi", "Calisma",
      "Yakinda", "Ayarlar Kaydedildi", "gecersiz", "baglanti",
    ];
    const text = values(tr).map(([, value]) => value).join(" ");
    for (const word of banned) {
      expect(text, `diakritiksiz yazım bulundu: ${word}`).not.toContain(word);
    }
  });
});
