import fs from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Baslaticilar depoyu klonlayan kullaniciyi calisir hale getirmeli.
 *
 * Onceki surumleri `node_modules` yoksa "npm install calistirin" deyip
 * cikiyordu -- yani sifir kurulum vaadi ancak kullanicinin sisteminde
 * Node varsa tutuyordu. Tasinabilir npm zaten indirilmis oluyor.
 */
const LAUNCHERS = ["start.command", "start.ps1"];

describe("baslatici betikleri", () => {
  it("bagimliliklari tasinabilir npm ile kurar", () => {
    for (const file of LAUNCHERS) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).toMatch(/npm (ci|install)/);
      expect(source, file).toContain("node_modules");
    }
  });

  it("eksik bagimlilikta pes etmez", () => {
    for (const file of LAUNCHERS) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toContain("Gelistirici kopyasindaysaniz");
    }
  });

  it("sistem Node'u aramaz, kendi indirdigini kullanir", () => {
    const source = fs.readFileSync("start.command", "utf8");
    expect(source).toContain('NODE_BIN="$ROOT/runtime/node/bin/node"');
  });
});
