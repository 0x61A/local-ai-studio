import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findProjectorFor,
  normalizeModelName,
  normalizeProjectorName,
} from "../src/models/projector.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-proj-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function put(...names: string[]) {
  for (const name of names) fs.writeFileSync(path.join(dir, name), "x");
}

describe("ad normalleştirme", () => {
  it("nicemleme kuyruğunu atar", () => {
    expect(normalizeModelName("Qwen2-VL-7B-Instruct-Q4_K_M.gguf")).toBe("qwen2-vl-7b-instruct");
    expect(normalizeModelName("Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf")).toBe(
      "llama-3-2-11b-vision-instruct",
    );
    expect(normalizeModelName("MiniCPM-V-2_6-Q4_K_M.gguf")).toBe("minicpm-v-2-6");
  });

  it("projektör işaretlerini ve hassasiyeti atar", () => {
    expect(normalizeProjectorName("mmproj-Qwen2-VL-7B-Instruct-f16.gguf")).toBe(
      "qwen2-vl-7b-instruct",
    );
    expect(normalizeProjectorName("Llama-3.2-11B-Vision-Instruct-mmproj.f16.gguf")).toBe(
      "llama-3-2-11b-vision-instruct",
    );
    expect(normalizeProjectorName("mmproj-MiniCPM-V-2_6-f16.gguf")).toBe("minicpm-v-2-6");
  });
});

describe("projektör eşleştirme", () => {
  it("gerçek dosya adı çiftlerini eşleştirir", () => {
    // Adlar Hugging Face'ten cozulüyor; burada gercek ornekleri sabitliyoruz.
    const pairs: Array<[string, string]> = [
      ["Qwen2-VL-7B-Instruct-Q4_K_M.gguf", "mmproj-Qwen2-VL-7B-Instruct-f16.gguf"],
      [
        "Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf",
        "Llama-3.2-11B-Vision-Instruct-mmproj.f16.gguf",
      ],
      ["MiniCPM-V-2_6-Q4_K_M.gguf", "mmproj-MiniCPM-V-2_6-f16.gguf"],
      [
        "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf",
        "mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf",
      ],
    ];
    for (const [model, projector] of pairs) {
      put(model, projector);
      expect(findProjectorFor(dir, model), model).toBe(projector);
      fs.rmSync(path.join(dir, model));
      fs.rmSync(path.join(dir, projector));
    }
  });

  it("görsel olmayan modele projektör bağlamaz", () => {
    put("Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "mmproj-MiniCPM-V-2_6-f16.gguf");
    expect(findProjectorFor(dir, "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")).toBeNull();
  });

  it("tek mmproj var diye onu seçmez", () => {
    // Yanlış modelin kodlayıcısını bağlamak çöp çıktı üretir ve nedeni
    // hiçbir yerde görünmez; eşleşme yoksa hiç bağlamamak doğrusu.
    put("Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf", "mmproj-Qwen2-VL-7B-Instruct-f16.gguf");
    expect(findProjectorFor(dir, "Llama-3.2-11B-Vision-Instruct.Q4_K_M.gguf")).toBeNull();
  });

  it("birden fazla mmproj arasından doğrusunu seçer", () => {
    put(
      "MiniCPM-V-2_6-Q4_K_M.gguf",
      "mmproj-Qwen2-VL-7B-Instruct-f16.gguf",
      "mmproj-MiniCPM-V-2_6-f16.gguf",
    );
    expect(findProjectorFor(dir, "MiniCPM-V-2_6-Q4_K_M.gguf")).toBe(
      "mmproj-MiniCPM-V-2_6-f16.gguf",
    );
  });

  it("olmayan klasörde çökmez", () => {
    expect(findProjectorFor(path.join(dir, "yok"), "a-Q4_K_M.gguf")).toBeNull();
  });
});

describe("cevirici GGUF ust verisi", () => {
  it("<bos> otomatik ekleme acik", () => {
    // Egitim bicimi her ornekte <bos> ile basliyor. Eklemeyi unutmak kisa
    // girdilerde ilk uretilen simgeyi dogrudan <eos> yapiyordu: "selam"
    // sorusuna 30 denemenin 30'unda bos cevap donuyordu.
    const source = fs.readFileSync("scripts/convert/pt-gpt2-to-gguf.py", "utf8");
    expect(source).toContain('"tokenizer.ggml.add_bos_token", True');
    expect(source).toContain('"tokenizer.ggml.add_eos_token", False');
  });
});
