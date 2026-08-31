import fs from "node:fs";

/**
 * GGUF başlık okuyucu.
 *
 * Referans proje model boyutunu ve mimarisini dosya adından tahmin
 * ediyordu ("7b" geçiyorsa 7 milyar parametre gibi). Bu, yeniden
 * adlandırılmış dosyalarda ve alışılmadık adlandırmalarda yanlış bellek
 * hesabına ve OOM'a yol açar.
 *
 * Burada gerçek başlık okunur: katman sayısı, gömme boyutu, KV başlık
 * sayısı ve eğitim bağlam uzunluğu. KV önbelleği bu değerlerden tam olarak
 * hesaplanabilir, tahminle değil.
 *
 * Yalnızca baştaki birkaç yüz KB okunur; tensör verisine dokunulmaz.
 */

const MAGIC = 0x46554747; // "GGUF" küçük endian
const HEADER_READ_BYTES = 8 * 1024 * 1024; // metadata bloğu için fazlasıyla yeterli

export interface GgufInfo {
  architecture: string;
  /** Katman (blok) sayısı. Bilinmiyorsa 0. */
  blockCount: number;
  embeddingLength: number;
  /** Grouped-query attention'da KV başlık sayısı; KV önbelleği bununla ölçeklenir. */
  headCountKv: number;
  headCount: number;
  /** Modelin eğitildiği en büyük bağlam. */
  trainContextLength: number;
  /** Dosya boyutu (bayt). */
  fileSizeBytes: number;
  /** Kaba nicemleme etiketi, dosya adından değil tensör tiplerinden. */
  quantization: string;
  /** Gömme modeli mi (sohbet için kullanılamaz). */
  isEmbedding: boolean;
  name: string;
}

export class GgufParseError extends Error {}

export function readGgufInfo(filePath: string): GgufInfo {
  const info = readGgufInfoRaw(filePath);
  if (info.quantization === "bilinmiyor") {
    // Son çare: dosya adı. Başlık her zaman parameter_count taşımıyor.
    // Sıra önemli -- referans proje SADECE dosya adına bakıyordu.
    const fromName = quantizationFromFilename(filePath);
    if (fromName) return { ...info, quantization: fromName };
  }
  return info;
}

/** "...-Q4_K_M.gguf" gibi adlardan nicemleme etiketi çıkarır. */
export function quantizationFromFilename(filePath: string): string | null {
  const name = filePath.split("/").pop() ?? "";
  const match = name.match(/[.\-_](IQ\d[A-Z_]*|Q\d[A-Z0-9_]*|BF16|F16|F32)\b/i);
  return match?.[1] ? match[1].toUpperCase() : null;
}

function readGgufInfoRaw(filePath: string): GgufInfo {
  const stats = fs.statSync(filePath);
  const handle = fs.openSync(filePath, "r");
  let buffer: Buffer;
  try {
    const length = Math.min(HEADER_READ_BYTES, stats.size);
    buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, 0);
  } finally {
    fs.closeSync(handle);
  }
  return parseGgufHeader(buffer, stats.size);
}

export function parseGgufHeader(buffer: Buffer, fileSizeBytes: number): GgufInfo {
  const reader = new Reader(buffer);

  if (reader.u32() !== MAGIC) {
    throw new GgufParseError("Dosya GGUF değil (sihirli sayı uyuşmuyor).");
  }
  const version = reader.u32();
  if (version < 2 || version > 3) {
    throw new GgufParseError(`Desteklenmeyen GGUF sürümü: ${version}`);
  }

  const tensorCount = Number(reader.u64());
  const kvCount = Number(reader.u64());
  if (kvCount < 0 || kvCount > 100_000) {
    throw new GgufParseError("GGUF metadata sayısı makul değil; dosya bozuk olabilir.");
  }

  const metadata = new Map<string, MetaValue>();
  for (let index = 0; index < kvCount; index += 1) {
    const key = reader.string();
    metadata.set(key, reader.value());
  }

  const architecture = str(metadata.get("general.architecture")) || "bilinmiyor";
  const prefixed = (suffix: string): number =>
    num(metadata.get(`${architecture}.${suffix}`));

  const headCount = prefixed("attention.head_count");
  const headCountKv = prefixed("attention.head_count_kv") || headCount;

  return {
    architecture,
    blockCount: prefixed("block_count"),
    embeddingLength: prefixed("embedding_length"),
    headCount,
    headCountKv,
    trainContextLength: prefixed("context_length"),
    fileSizeBytes,
    quantization: quantizationLabel(metadata, fileSizeBytes, tensorCount),
    // Gömme modellerinde pooling tipi tanımlıdır ve çıktı katmanı yoktur.
    isEmbedding:
      metadata.has(`${architecture}.pooling_type`) ||
      /embed|bge|gte|e5|nomic/i.test(str(metadata.get("general.name"))),
    name: str(metadata.get("general.name")) || architecture,
  };
}

/**
 * Model + KV önbelleği için gereken belleği tahmin eder.
 *
 * KV önbelleği = 2 (K ve V) × katman × bağlam × kv_boyutu × eleman_baytı
 * Burada kv_boyutu = embedding_length × head_count_kv / head_count
 * (grouped-query attention'da KV başlıkları sorgu başlıklarından azdır).
 */
export function estimateMemoryMb(
  info: GgufInfo,
  contextTokens: number,
  cacheBytesPerElement = 1, // q8_0 KV önbelleği
): { modelMb: number; kvCacheMb: number; totalMb: number } {
  const modelMb = Math.ceil(info.fileSizeBytes / (1024 * 1024));

  const kvDim =
    info.headCount > 0
      ? (info.embeddingLength * info.headCountKv) / info.headCount
      : info.embeddingLength;
  const kvBytes = 2 * info.blockCount * contextTokens * kvDim * cacheBytesPerElement;
  const kvCacheMb = Math.ceil(kvBytes / (1024 * 1024));

  // Hesaplama tamponları ve çalışma alanı için sabit pay.
  const overheadMb = 256;
  return { modelMb, kvCacheMb, totalMb: modelMb + kvCacheMb + overheadMb };
}

// -- İkili okuyucu ------------------------------------------------------------

type MetaValue = string | number | boolean | bigint | MetaValue[];

class Reader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  private need(bytes: number): void {
    if (this.offset + bytes > this.buffer.length) {
      throw new GgufParseError(
        "GGUF başlığı okunan bloğa sığmadı; dosya kesik veya alışılmadık.",
      );
    }
  }

  u32(): number {
    this.need(4);
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  u64(): bigint {
    this.need(8);
    const value = this.buffer.readBigUInt64LE(this.offset);
    this.offset += 8;
    return value;
  }

  string(): string {
    const length = Number(this.u64());
    if (length > 64 * 1024 * 1024) {
      throw new GgufParseError("GGUF metin alanı makul olmayacak kadar uzun.");
    }
    this.need(length);
    const value = this.buffer.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  value(): MetaValue {
    return this.typedValue(this.u32());
  }

  private typedValue(type: number): MetaValue {
    switch (type) {
      case 0: this.need(1); return this.buffer.readUInt8(this.offset++);
      case 1: this.need(1); return this.buffer.readInt8(this.offset++);
      case 2: { this.need(2); const v = this.buffer.readUInt16LE(this.offset); this.offset += 2; return v; }
      case 3: { this.need(2); const v = this.buffer.readInt16LE(this.offset); this.offset += 2; return v; }
      case 4: return this.u32();
      case 5: { this.need(4); const v = this.buffer.readInt32LE(this.offset); this.offset += 4; return v; }
      case 6: { this.need(4); const v = this.buffer.readFloatLE(this.offset); this.offset += 4; return v; }
      case 7: { this.need(1); return this.buffer.readUInt8(this.offset++) !== 0; }
      case 8: return this.string();
      case 9: {
        const elementType = this.u32();
        const count = Number(this.u64());
        if (count > 10_000_000) {
          throw new GgufParseError("GGUF dizisi makul olmayacak kadar uzun.");
        }
        const items: MetaValue[] = [];
        for (let index = 0; index < count; index += 1) {
          items.push(this.typedValue(elementType));
        }
        return items;
      }
      case 10: return this.u64();
      case 11: { this.need(8); const v = this.buffer.readBigInt64LE(this.offset); this.offset += 8; return v; }
      case 12: { this.need(8); const v = this.buffer.readDoubleLE(this.offset); this.offset += 8; return v; }
      default:
        throw new GgufParseError(`Bilinmeyen GGUF değer tipi: ${type}`);
    }
  }
}

function str(value: MetaValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function num(value: MetaValue | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

/**
 * Nicemlemeyi dosya adı yerine ortalama bit/ağırlık oranından tahmin eder.
 * Kesin tensör tipi listesi başlıkta yok; oran pratikte ayırt edici.
 */
function quantizationLabel(
  metadata: Map<string, MetaValue>,
  fileSizeBytes: number,
  tensorCount: number,
): string {
  const explicit = str(metadata.get("general.file_type_name"));
  if (explicit) return explicit;

  const parameters = num(metadata.get("general.parameter_count"));
  if (parameters > 0) {
    const bitsPerWeight = (fileSizeBytes * 8) / parameters;
    if (bitsPerWeight > 15) return "F16";
    if (bitsPerWeight > 7.5) return "Q8";
    if (bitsPerWeight > 5.5) return "Q6";
    if (bitsPerWeight > 4.7) return "Q5";
    if (bitsPerWeight > 3.7) return "Q4";
    if (bitsPerWeight > 2.7) return "Q3";
    return "Q2";
  }
  return tensorCount > 0 ? "bilinmiyor" : "bilinmiyor";
}
