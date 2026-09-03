import { describe, expect, it } from "vitest";
import { formatGb } from "../src/lib/format";

describe("boyut biçimi", () => {
  it("MB değerini yuvarlar", () => {
    // Değer bayttan bölünerek geliyor; yuvarlamadan basmak arayüzde
    // "139.3760986328125 MB" gibi bir şey gösteriyordu.
    expect(formatGb(139.3760986328125)).toBe("139 MB");
    expect(formatGb(1023.7)).toBe("1024 MB");
  });

  it("1 GB üstünü GB olarak yazar", () => {
    expect(formatGb(2048)).toBe("2.0 GB");
    expect(formatGb(4777)).toBe("4.7 GB");
  });

  it("sıfır ve negatifte tire", () => {
    expect(formatGb(0)).toBe("-");
    expect(formatGb(-5)).toBe("-");
  });
});
