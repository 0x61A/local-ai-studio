import fs from "node:fs";
import path from "node:path";
import { isProjector } from "./huggingface.js";

/**
 * Yerel projektör (mmproj) eşleştirme.
 *
 * Görsel modeller iki dosyadır: dil modeli ve görüntü kodlayıcı. İkincisi
 * verilmezse llama.cpp modeli sorunsuz yükler ama görsel göremez -- yani
 * hata vermeden metin modeline dönüşür. Sessiz bozulmanın en kötü türü:
 * kullanıcı görsel modeli indirdiğini sanar, model "göremiyorum" der.
 *
 * Bu yüzden eşleştirme yükleme anında ve otomatik yapılır; kullanıcının
 * doğru mmproj dosyasını elle seçmesi beklenmez.
 */

/** Nicemleme ve dosya uzantısı atılır; kalan model kimliğidir. */
export function normalizeModelName(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.gguf$/, "")
    .replace(/[._]/g, "-")
    // "-q4-k-m", "-q8-0", "-iq3-xs", "-f16" gibi nicemleme kuyrukları.
    .replace(/-(?:iq|q)\d+(?:-[a-z0-9]+)*$/, "")
    .replace(/-f(?:16|32)$/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Projektör adından "mmproj" işaretleri ve hassasiyet kuyruğu atılır. */
export function normalizeProjectorName(filename: string): string {
  return normalizeModelName(filename)
    .replace(/mmproj|projector/g, "")
    .replace(/-f(?:16|32)$/, "")
    .replace(/-model$/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * `dir` içinde `modelFilename` ile eşleşen projektörü bulur.
 *
 * Tek bir mmproj dosyası var diye onu seçmeyiz: yanlış modelin kodlayıcısını
 * bağlamak çöpe benzeyen çıktı üretir ve nedeni hiç görünmez.
 */
export function findProjectorFor(dir: string, modelFilename: string): string | null {
  const base = normalizeModelName(modelFilename);
  if (!base) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const candidates = entries.filter((name) => isProjector(name));
  for (const candidate of candidates) {
    const stem = normalizeProjectorName(candidate);
    if (!stem) continue;
    if (base.includes(stem) || stem.includes(base)) return candidate;
  }
  return null;
}

export function projectorPathFor(dir: string, modelFilename: string): string | null {
  const found = findProjectorFor(dir, modelFilename);
  return found ? path.join(dir, found) : null;
}
