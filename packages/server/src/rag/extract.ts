import path from "node:path";
import { ZipError, readZipEntry } from "./zip.js";

/**
 * Belge metni çıkarma.
 *
 * pdf.js ayrı bir iş parçacığı yerine "sahte işçi" ile çalışır: işçi modülü
 * pakete gömülür ve `globalThis.pdfjsWorker` üzerinden verilir. Böylece
 * çalışma anında dosya yolu çözmeye gerek kalmaz -- tek dosyalık sunucu
 * paketiyle uyumlu tek yol bu.
 *
 * Sayfa sayfa `await` edilir; büyük bir PDF ayrıştırılırken olay döngüsü
 * tamamen bloke olmaz, arayüz ilerlemeyi görmeye devam eder.
 */

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjs: PdfjsModule | null = null;

/**
 * pdf.js ilk PDF'e kadar yüklenmez. Modül yüklenirken Node'da
 * çalıştırılamayan tarayıcı çoklu dolguları için uyarı basar; PDF
 * ayrıştırmayan bir oturumda o gürültünün açılış günlüğünde işi yok.
 */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (pdfjs) return pdfjs;
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  (globalThis as Record<string, unknown>)["pdfjsWorker"] = worker;
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

export type DocumentKind = "pdf" | "docx" | "markdown" | "text" | "code";

export interface ExtractedPage {
  /** 1'den başlar. Tek parçalı belgelerde her zaman 1. */
  page: number;
  text: string;
}

export interface ExtractedDocument {
  kind: DocumentKind;
  pages: ExtractedPage[];
  /** Belgenin kendi bildirdiği başlık; yoksa boş. */
  title: string;
}

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

const MAX_PAGES = 2000;
const MAX_TOTAL_CHARS = 8_000_000;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".sh",
  ".sql", ".css", ".scss", ".html", ".yml", ".yaml", ".json", ".toml", ".xml",
]);
const TEXT_EXTENSIONS = new Set([".txt", ".text", ".log", ".csv", ".tsv", ".rst"]);

export function kindFor(filename: string): DocumentKind | null {
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx") return "docx";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return null;
}

export function supportedExtensions(): string[] {
  return [
    ".pdf", ".docx",
    ...MARKDOWN_EXTENSIONS, ...TEXT_EXTENSIONS, ...CODE_EXTENSIONS,
  ];
}

export async function extractDocument(
  filename: string,
  bytes: Buffer,
): Promise<ExtractedDocument> {
  const kind = kindFor(filename);
  if (!kind) {
    throw new ExtractError(
      `Desteklenmeyen dosya türü: ${path.extname(filename) || filename}. ` +
        `Desteklenen: ${supportedExtensions().join(", ")}`,
    );
  }
  if (kind === "pdf") return extractPdf(bytes);
  if (kind === "docx") return extractDocx(bytes);
  return extractPlain(kind, bytes);
}

// -- PDF ----------------------------------------------------------------------

interface PdfTextItem {
  str?: string;
  width?: number;
  height?: number;
  hasEOL?: boolean;
  transform?: number[];
}

async function extractPdf(bytes: Buffer): Promise<ExtractedDocument> {
  const { getDocument } = await loadPdfjs();
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
  });

  let document: Awaited<typeof task.promise>;
  try {
    document = await task.promise;
  } catch (err) {
    throw new ExtractError(`PDF okunamadı: ${(err as Error).message}`);
  }

  try {
    const meta = await document.getMetadata().catch(() => null);
    const info = meta?.info as { Title?: string } | undefined;
    const pages: ExtractedPage[] = [];
    let total = 0;
    const pageCount = Math.min(document.numPages, MAX_PAGES);

    for (let number = 1; number <= pageCount; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = joinTextItems(content.items as PdfTextItem[]);
      page.cleanup();
      total += text.length;
      pages.push({ page: number, text });
      if (total > MAX_TOTAL_CHARS) break;
    }

    if (pages.every((entry) => entry.text.trim() === "")) {
      throw new ExtractError(
        "PDF'ten metin çıkarılamadı. Taranmış (görüntü) bir belge olabilir; " +
          "metin katmanı olan bir sürüm gerekir.",
      );
    }
    return { kind: "pdf", pages, title: (info?.Title ?? "").trim() };
  } finally {
    await task.destroy();
  }
}

/**
 * PDF metin parçalarını birleştirir.
 *
 * PDF'te boşluk diye bir şey yoktur; yalnızca konumlanmış parçalar vardır.
 * Naif `join(" ")` kelimeleri bölen kerning parçalarını da ayırır
 * ("mo del"); naif `join("")` ise kelimeleri birbirine yapıştırır.
 * Bu yüzden yatay boşluğa bakılır: önceki parçanın bittiği yerle yenisinin
 * başladığı yer arasında gözle görülür aralık varsa boşluk konur.
 */
export function joinTextItems(items: PdfTextItem[]): string {
  let out = "";
  let previousEndX: number | null = null;
  let previousY: number | null = null;

  for (const item of items) {
    const text = item.str ?? "";
    if (item.hasEOL && text === "") {
      out += "\n";
      previousEndX = null;
      previousY = null;
      continue;
    }
    if (text === "") continue;

    const x = item.transform?.[4] ?? 0;
    const y = item.transform?.[5] ?? 0;
    const height = item.height ?? 10;

    if (previousY !== null && Math.abs(y - previousY) > Math.max(1, height * 0.5)) {
      out += "\n";
    } else if (previousEndX !== null) {
      const gap = x - previousEndX;
      // Eşik yazı boyuna göre: 8 punto metinde 2 birim aralık boşluktur,
      // 40 punto başlıkta değildir.
      if (gap > Math.max(0.8, height * 0.15)) out += " ";
    }

    out += text;

    if (item.hasEOL) {
      out += "\n";
      previousEndX = null;
      previousY = null;
    } else {
      previousEndX = x + (item.width ?? 0);
      previousY = y;
    }
  }
  // Aralık sezgisi kelime içi parçaları da ayırabildiği için çift boşluk
  // kalır; gömme için gürültüdür.
  // Satır sonu tirelemesi: "kul-\nlanim" tek kelimedir, bölünmüş hâli
  // gömmede de aramada da eşleşmez.
  const dehyphenated = out.replace(/(\p{L})-\n(\p{L})/gu, "$1$2");
  return normalizeWhitespace(dehyphenated.replace(/ {2,}/g, " "));
}

// -- DOCX ---------------------------------------------------------------------

/**
 * OOXML'den metin. Tam bir XML ayrıştırıcısı kurmak yerine metin
 * çalıştırmaları (`w:t`) ve paragraf sınırları taranır: DOCX'in metin
 * katmanı bu iki yapıdan ibarettir, gerisi biçimlendirmedir.
 */
export function docxXmlToText(xml: string): string {
  // Alan kodları (`w:instrText`) kullanıcı metni değil; HYPERLINK, PAGE gibi
  // komutlar gövdeye karışmasın.
  const body = xml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "");
  const pattern =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/?>|<w:br\s*\/?>|<\/w:p>/g;

  let out = "";
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const token = match[0];
    if (match[1] !== undefined) out += decodeXmlEntities(match[1]);
    else if (token.startsWith("<w:tab")) out += "\t";
    else out += "\n";
  }
  return normalizeWhitespace(out);
}

function extractDocx(bytes: Buffer): ExtractedDocument {
  let xml: Buffer | null;
  try {
    xml = readZipEntry(bytes, "word/document.xml");
  } catch (err) {
    if (err instanceof ZipError) throw new ExtractError(`DOCX açılamadı: ${err.message}`);
    throw err;
  }
  if (!xml) {
    throw new ExtractError(
      "DOCX içinde word/document.xml yok. Dosya .doc (eski biçim) olabilir; " +
        "Word'de .docx olarak kaydedin.",
    );
  }
  const text = docxXmlToText(xml.toString("utf8"));
  if (!text.trim()) throw new ExtractError("DOCX belgesinde metin bulunamadı.");
  return { kind: "docx", pages: [{ page: 1, text }], title: "" };
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      default: break;
    }
    const code = entity.startsWith("#x") || entity.startsWith("#X")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

// -- Düz metin ----------------------------------------------------------------

function extractPlain(kind: DocumentKind, bytes: Buffer): ExtractedDocument {
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new ExtractError("Dosya ikili görünüyor, metin olarak okunamıyor.");
  }
  const text = normalizeWhitespace(stripBom(bytes.toString("utf8")));
  if (!text.trim()) throw new ExtractError("Dosya boş.");
  return {
    kind,
    pages: [{ page: 1, text: text.slice(0, MAX_TOTAL_CHARS) }],
    title: "",
  };
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Satır sonlarını tekilleştirir; üçten fazla boş satır bilgi taşımaz. */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
