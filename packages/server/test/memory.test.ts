import { describe, expect, it } from "vitest";
import os from "node:os";
import {
  getAvailableMemoryMb,
  parseVmStatAvailableMb,
} from "../src/hardware/detect.js";

// Gercek `vm_stat` ciktisi (macOS 26, Apple M4, 16 GB).
const SAMPLE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    40464.
Pages active:                                 372420.
Pages inactive:                               368341.
Pages speculative:                              3211.
Pages throttled:                                   0.
Pages wired down:                             121133.
Pages purgeable:                               16724.
"Translation faults":                       31660701.
`;

describe("parseVmStatAvailableMb", () => {
  it("geri alinabilir sayfalari toplar", () => {
    // free + inactive + speculative + purgeable = 428740 sayfa
    const expected = Math.floor((428740 * 16384) / (1024 * 1024));
    expect(parseVmStatAvailableMb(SAMPLE, 16384)).toBe(expected);
  });

  it("os.freemem()'in gosterdiginden belirgin sekilde buyuk olmali", () => {
    // Hatanin ozu buydu: yalnizca "Pages free" sayilirsa 16 GB'lik makinede
    // ~0.6 GB gorunur. Geri alinabilirlerle birlikte cok daha buyuk olmali.
    const freeOnlyMb = Math.floor((40464 * 16384) / (1024 * 1024));
    expect(parseVmStatAvailableMb(SAMPLE, 16384)).toBeGreaterThan(freeOnlyMb * 5);
  });

  it("ayristirilamayan ciktida null doner", () => {
    expect(parseVmStatAvailableMb("beklenmeyen cikti", 16384)).toBeNull();
    expect(parseVmStatAvailableMb("", 16384)).toBeNull();
  });
});

describe("getAvailableMemoryMb", () => {
  it("makul bir aralikta deger uretir", () => {
    const totalMb = Math.floor(os.totalmem() / (1024 * 1024));
    const available = getAvailableMemoryMb();
    expect(available).toBeGreaterThan(0);
    expect(available).toBeLessThanOrEqual(totalMb);
  });
});
