import zlib from "node:zlib";

/**
 * Asgari ZIP okuyucu.
 *
 * DOCX bir ZIP arşividir; içinden yalnızca `word/document.xml` gerekir.
 * Native modül ya da yeni bir bağımlılık eklemek yerine merkezi dizini
 * kendimiz okuyup `zlib.inflateRawSync` ile açıyoruz -- sıfır-kurulum
 * vaadi npm prebuild matrisine dayanamaz.
 *
 * Bilerek desteklenmeyenler: şifreli arşiv, Zip64, çok parçalı arşiv.
 * Hepsi sessizce yanlış veri üretmek yerine açık hata verir.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** EOCD'den sonra en fazla 64 KB yorum olabilir. */
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_MARKER = 0xffffffff;
/** Zip bombasına karşı: tek girdi için üst sınır. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Merkezi dizini okur. Girdi verisi açılmaz; yalnızca listelenir. */
export function listZipEntries(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === ZIP64_MARKER) {
    throw new ZipError("Zip64 arşivleri desteklenmiyor.");
  }

  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length) {
      throw new ZipError("Merkezi dizin dosyanın dışına taşıyor.");
    }
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError("Merkezi dizin girdisi bozuk.");
    }
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    entries.push({
      name: buffer.toString("utf8", offset + 46, offset + 46 + nameLength),
      compressionMethod: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      uncompressedSize: buffer.readUInt32LE(offset + 24),
      localHeaderOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Adı verilen girdiyi açar. Yoksa null döner. */
export function readZipEntry(buffer: Buffer, name: string): Buffer | null {
  const entry = listZipEntries(buffer).find((candidate) => candidate.name === name);
  if (!entry) return null;

  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new ZipError(
      `Arşiv girdisi çok büyük: ${name} (${entry.uncompressedSize} bayt).`,
    );
  }

  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new ZipError(`Yerel başlık bozuk: ${name}`);
  }
  // Yerel başlıktaki ad/ek alan uzunlukları merkezi dizindekinden farklı
  // olabilir; veri konumu için yerel başlık bağlayıcıdır.
  const dataStart =
    header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (data.length !== entry.compressedSize) {
    throw new ZipError(`Arşiv eksik: ${name} verisi dosyanın dışında.`);
  }

  if (entry.compressionMethod === 0) return Buffer.from(data);
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  }
  throw new ZipError(
    `Desteklenmeyen sıkıştırma yöntemi (${entry.compressionMethod}): ${name}`,
  );
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN_SIZE) throw new ZipError("Dosya ZIP arşivi değil.");
  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT_BYTES);
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipError("ZIP merkezi dizini bulunamadı; dosya bozuk olabilir.");
}
