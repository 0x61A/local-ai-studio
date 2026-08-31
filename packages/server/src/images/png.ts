/**
 * Asgari PNG okuyucu.
 *
 * İki şey için: gerçek boyut (IHDR) ve motorun görselin içine gömdüğü
 * üretim parametreleri (tEXt/iTXt). Tohumu istekten kopyalamak yerine
 * dosyadan okumak, "aynı görseli yeniden üret" düğmesinin gerçekten
 * çalışmasını sağlar -- tohum -1 gönderildiğinde gerçek değeri yalnızca
 * motor bilir.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Metin parçalarında dolaşırken üst sınır; bozuk dosyada sonsuz döngü olmasın. */
const MAX_CHUNKS = 512;

export interface PngInfo {
  width: number;
  height: number;
  text: Map<string, string>;
}

export function readPng(buffer: Buffer): PngInfo {
  const text = new Map<string, string>();
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    return { width: 0, height: 0, text };
  }

  let width = 0;
  let height = 0;
  let offset = 8;

  for (let seen = 0; seen < MAX_CHUNKS && offset + 8 <= buffer.length; seen += 1) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;

    if (type === "IHDR" && length >= 8) {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
    } else if (type === "tEXt") {
      const data = buffer.subarray(dataStart, dataEnd);
      const split = data.indexOf(0);
      if (split > 0) {
        text.set(
          data.toString("latin1", 0, split),
          data.toString("latin1", split + 1),
        );
      }
    } else if (type === "iTXt") {
      const entry = parseITxt(buffer.subarray(dataStart, dataEnd));
      if (entry) text.set(entry[0], entry[1]);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  return { width, height, text };
}

/**
 * iTXt: anahtar\0 sıkıştırma bayrağı, yöntem, dil\0 çevrilmiş anahtar\0 metin.
 * Sıkıştırılmış olanı atlarız; motorlar parametreleri sıkıştırmadan yazar.
 */
function parseITxt(data: Buffer): [string, string] | null {
  const keyEnd = data.indexOf(0);
  if (keyEnd <= 0 || keyEnd + 2 >= data.length) return null;
  if (data[keyEnd + 1] !== 0) return null; // sıkıştırılmış
  const languageEnd = data.indexOf(0, keyEnd + 3);
  if (languageEnd === -1) return null;
  const translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd === -1) return null;
  return [
    data.toString("utf8", 0, keyEnd),
    data.toString("utf8", translatedEnd + 1),
  ];
}

/**
 * A1111 biçimli parametre metninden alan okur:
 * "istem\nNegative prompt: ...\nSteps: 20, Sampler: euler_a, CFG scale: 7, Seed: 42, Size: 512x512"
 */
export function readParameter(parameters: string, key: string): string | null {
  const match = new RegExp(`(?:^|,|\\n)\\s*${key}:\\s*([^,\\n]+)`, "i").exec(parameters);
  return match?.[1]?.trim() ?? null;
}

/** Görselden gerçek tohumu okur; bulunamazsa null. */
export function readSeed(info: PngInfo): number | null {
  for (const value of info.text.values()) {
    const seed = readParameter(value, "Seed");
    if (seed !== null) {
      const parsed = Number.parseInt(seed, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}
