import { describe, expect, it } from "vitest";
import {
  GgufParseError,
  quantizationFromFilename,
  estimateMemoryMb,
  parseGgufHeader,
  type GgufInfo,
} from "../src/models/gguf.js";

/** Test için sentetik GGUF başlığı üretir. */
function buildGguf(
  entries: Array<[string, { type: number; value: unknown }]>,
  options: { magic?: number; version?: number; tensorCount?: number } = {},
): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string) => {
    const body = Buffer.from(s, "utf8");
    return Buffer.concat([u64(body.length), body]);
  };

  parts.push(u32(options.magic ?? 0x46554747));
  parts.push(u32(options.version ?? 3));
  parts.push(u64(options.tensorCount ?? 100));
  parts.push(u64(entries.length));

  for (const [key, { type, value }] of entries) {
    parts.push(str(key));
    parts.push(u32(type));
    if (type === 8) parts.push(str(String(value)));
    else if (type === 4) parts.push(u32(Number(value)));
    else if (type === 10) parts.push(u64(Number(value)));
    else if (type === 6) {
      const b = Buffer.alloc(4);
      b.writeFloatLE(Number(value));
      parts.push(b);
    } else if (type === 7) parts.push(Buffer.from([value ? 1 : 0]));
    else if (type === 9) {
      const items = value as number[];
      parts.push(u32(4));
      parts.push(u64(items.length));
      for (const item of items) parts.push(u32(item));
    }
  }
  return Buffer.concat(parts);
}

const LLAMA_7B: Array<[string, { type: number; value: unknown }]> = [
  ["general.architecture", { type: 8, value: "llama" }],
  ["general.name", { type: 8, value: "Test Llama 7B" }],
  ["general.parameter_count", { type: 10, value: 7_000_000_000 }],
  ["llama.block_count", { type: 4, value: 32 }],
  ["llama.embedding_length", { type: 4, value: 4096 }],
  ["llama.attention.head_count", { type: 4, value: 32 }],
  ["llama.attention.head_count_kv", { type: 4, value: 8 }],
  ["llama.context_length", { type: 4, value: 8192 }],
];

describe("parseGgufHeader", () => {
  it("mimari ve boyut alanlarını okur", () => {
    const info = parseGgufHeader(buildGguf(LLAMA_7B), 4_000_000_000);
    expect(info).toMatchObject<Partial<GgufInfo>>({
      architecture: "llama",
      blockCount: 32,
      embeddingLength: 4096,
      headCount: 32,
      headCountKv: 8,
      trainContextLength: 8192,
      name: "Test Llama 7B",
    });
  });

  it("nicemlemeyi bit/ağırlık oranından çıkarır, dosya adından değil", () => {
    // 7 milyar parametre, 4 GB dosya -> ~4.6 bit/ağırlık -> Q4
    expect(parseGgufHeader(buildGguf(LLAMA_7B), 4_000_000_000).quantization).toBe("Q4");
    // Aynı model 14 GB -> F16
    expect(parseGgufHeader(buildGguf(LLAMA_7B), 14_000_000_000).quantization).toBe("F16");
    // 7.5 GB -> Q8
    expect(parseGgufHeader(buildGguf(LLAMA_7B), 7_400_000_000).quantization).toBe("Q8");
  });

  it("head_count_kv yoksa head_count'a düşer", () => {
    const entries = LLAMA_7B.filter(([key]) => !key.includes("head_count_kv"));
    expect(parseGgufHeader(buildGguf(entries), 1000).headCountKv).toBe(32);
  });

  it("gömme modelini tanır", () => {
    const embedding: Array<[string, { type: number; value: unknown }]> = [
      ["general.architecture", { type: 8, value: "bert" }],
      ["general.name", { type: 8, value: "nomic-embed-text-v1.5" }],
      ["bert.block_count", { type: 4, value: 12 }],
    ];
    expect(parseGgufHeader(buildGguf(embedding), 1000).isEmbedding).toBe(true);
    expect(parseGgufHeader(buildGguf(LLAMA_7B), 1000).isEmbedding).toBe(false);
  });

  it("dizi ve kayan nokta değerlerini atlayabilir", () => {
    const withArrays: Array<[string, { type: number; value: unknown }]> = [
      ["general.architecture", { type: 8, value: "llama" }],
      ["tokenizer.ggml.token_type", { type: 9, value: [1, 1, 2, 3] }],
      ["llama.rope.freq_base", { type: 6, value: 10000.5 }],
      ["llama.block_count", { type: 4, value: 16 }],
    ];
    expect(parseGgufHeader(buildGguf(withArrays), 1000).blockCount).toBe(16);
  });

  it("GGUF olmayan dosyayı reddeder", () => {
    expect(() => parseGgufHeader(buildGguf([], { magic: 0x12345678 }), 100)).toThrow(
      GgufParseError,
    );
  });

  it("desteklenmeyen sürümü reddeder", () => {
    expect(() => parseGgufHeader(buildGguf([], { version: 99 }), 100)).toThrow(
      /Desteklenmeyen GGUF sürümü/,
    );
  });

  it("kesik dosyada anlaşılır hata verir, çökmez", () => {
    const full = buildGguf(LLAMA_7B);
    expect(() => parseGgufHeader(full.subarray(0, 40), 100)).toThrow(GgufParseError);
  });

  it("saçma metadata sayısını reddeder", () => {
    const bad = buildGguf([]);
    bad.writeBigUInt64LE(BigInt(999_999_999), 16); // kv sayısı alanı
    expect(() => parseGgufHeader(bad, 100)).toThrow(/makul değil/);
  });
});

describe("estimateMemoryMb", () => {
  const info = parseGgufHeader(buildGguf(LLAMA_7B), 4_000_000_000);

  it("model + KV önbelleği + pay toplar", () => {
    const estimate = estimateMemoryMb(info, 4096);
    expect(estimate.modelMb).toBe(Math.ceil(4_000_000_000 / (1024 * 1024)));
    expect(estimate.kvCacheMb).toBeGreaterThan(0);
    expect(estimate.totalMb).toBe(estimate.modelMb + estimate.kvCacheMb + 256);
  });

  it("KV önbelleği bağlamla doğrusal büyür", () => {
    const small = estimateMemoryMb(info, 2048).kvCacheMb;
    const large = estimateMemoryMb(info, 8192).kvCacheMb;
    expect(large).toBeCloseTo(small * 4, -1);
  });

  it("grouped-query attention KV önbelleğini küçültür", () => {
    // head_count_kv=8, head_count=32 -> KV boyutu dörtte bir
    const gqa = estimateMemoryMb(info, 4096).kvCacheMb;
    const mha = estimateMemoryMb({ ...info, headCountKv: 32 }, 4096).kvCacheMb;
    expect(mha).toBeCloseTo(gqa * 4, -1);
  });

  it("bilinen bir model için makul büyüklük verir", () => {
    // Llama 7B, 4096 bağlam, q8 KV: KV önbelleği ~130 MB mertebesinde olmalı
    const estimate = estimateMemoryMb(info, 4096);
    expect(estimate.kvCacheMb).toBeGreaterThan(50);
    expect(estimate.kvCacheMb).toBeLessThan(400);
  });
});

describe("quantizationFromFilename", () => {
  it("yaygın adlandırmaları tanır", () => {
    expect(quantizationFromFilename("Qwen2.5-0.5B-Instruct-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantizationFromFilename("model-IQ3_XS.gguf")).toBe("IQ3_XS");
    expect(quantizationFromFilename("/yol/model.f16.gguf")).toBe("F16");
    expect(quantizationFromFilename("a-Q8_0.gguf")).toBe("Q8_0");
  });

  it("bulamayınca null döner", () => {
    expect(quantizationFromFilename("model.gguf")).toBeNull();
    expect(quantizationFromFilename("random-name.gguf")).toBeNull();
  });
});
