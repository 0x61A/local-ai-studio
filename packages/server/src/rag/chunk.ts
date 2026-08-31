import type { ExtractedDocument } from "./extract.js";

/**
 * Parçalama.
 *
 * İki kural belirleyici:
 *  - Başlıklar sınırdır. Markdown başlığı görülünce yeni parça başlar ve
 *    başlık yolu parçanın metnine yazılır; böylece "3.2 Kurulum" altındaki
 *    bir cümle bağlamından koparılmadan aranabilir.
 *  - Sayfa sınırı aşılmaz. Sayfayı aşan bir parça, kaynak gösterirken
 *    hangi sayfaya ait olduğunu söyleyemezdi. Sayfa numarası doğruluğu
 *    birkaç cümlelik bağlamdan değerlidir.
 */

export interface Chunk {
  seq: number;
  page: number;
  /** "Bölüm 3 › Kurulum" biçiminde başlık yolu; yoksa boş. */
  heading: string;
  text: string;
}

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  overlapChars?: number;
}

const DEFAULTS = { targetChars: 1400, maxChars: 2200, overlapChars: 200 };
/** Bundan kısa artıklar tek başına parça olmaz, öncekine eklenir. */
const MIN_TAIL_CHARS = 120;

export function chunkDocument(
  document: ExtractedDocument,
  options: ChunkOptions = {},
): Chunk[] {
  const config = { ...DEFAULTS, ...options };
  const useHeadings = document.kind === "markdown";
  const chunks: Chunk[] = [];

  for (const page of document.pages) {
    for (const section of splitSections(page.text, useHeadings)) {
      for (const text of packBlocks(section.blocks, config)) {
        chunks.push({
          seq: chunks.length,
          page: page.page,
          heading: section.heading,
          text,
        });
      }
    }
  }
  return chunks;
}

interface Section {
  heading: string;
  blocks: string[];
}

/** Başlık satırını tanır: `## Kurulum` -> seviye 2. */
export function headingLevel(line: string): number {
  const match = /^(#{1,6})\s+\S/.exec(line);
  return match ? (match[1] as string).length : 0;
}

function splitSections(text: string, useHeadings: boolean): Section[] {
  if (!useHeadings) {
    const blocks = splitBlocks(text);
    return blocks.length ? [{ heading: "", blocks }] : [];
  }

  const sections: Section[] = [];
  const stack: string[] = [];
  let current: string[] = [];
  let heading = "";

  const flush = () => {
    const blocks = splitBlocks(current.join("\n"));
    if (blocks.length) sections.push({ heading, blocks });
    current = [];
  };

  for (const line of text.split("\n")) {
    const level = headingLevel(line);
    if (level === 0) {
      current.push(line);
      continue;
    }
    flush();
    const title = line.slice(level).trim();
    stack.length = Math.min(stack.length, level - 1);
    stack[level - 1] = title;
    heading = stack.filter(Boolean).join(" › ");
    // Başlığın kendisi parçanın içinde kalsın: model neyin altında
    // olduğunu metinden de görsün.
    current.push(title);
  }
  flush();
  return sections;
}

function splitBlocks(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function packBlocks(
  blocks: string[],
  config: Required<ChunkOptions>,
): string[] {
  const out: string[] = [];
  let buffer = "";

  const push = () => {
    const text = buffer.trim();
    if (!text) return;
    if (text.length < MIN_TAIL_CHARS && out.length > 0) {
      const previous = out[out.length - 1] as string;
      if (previous.length + text.length <= config.maxChars) {
        out[out.length - 1] = `${previous}\n\n${text}`;
        buffer = "";
        return;
      }
    }
    out.push(text);
    buffer = "";
  };

  for (const block of blocks) {
    for (const piece of block.length > config.maxChars
      ? splitLongBlock(block, config.maxChars)
      : [block]) {
      if (buffer && buffer.length + piece.length + 2 > config.targetChars) {
        const tail = overlapTail(buffer, config.overlapChars);
        push();
        buffer = tail;
      }
      buffer = buffer ? `${buffer}\n\n${piece}` : piece;
    }
  }
  push();
  return out;
}

/** Cümle sınırından böler; cümle de uzunsa sert keser. */
function splitLongBlock(block: string, maxChars: number): string[] {
  const sentences = block.match(/[^.!?\n]+[.!?]*\s*/g) ?? [block];
  const out: string[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buffer) {
        out.push(buffer.trim());
        buffer = "";
      }
      for (let at = 0; at < sentence.length; at += maxChars) {
        out.push(sentence.slice(at, at + maxChars).trim());
      }
      continue;
    }
    if (buffer.length + sentence.length > maxChars) {
      out.push(buffer.trim());
      buffer = "";
    }
    buffer += sentence;
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out.filter(Boolean);
}

/**
 * Parçalar arası örtüşme: sınırda kesilen bir cümle iki parçanın da
 * içinde geçsin ki arama onu bulabilsin.
 */
export function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return "";
  const tail = text.slice(-overlapChars);
  const boundary = tail.search(/[.!?]\s+\S/);
  return boundary === -1 ? tail.trimStart() : tail.slice(boundary + 1).trimStart();
}
