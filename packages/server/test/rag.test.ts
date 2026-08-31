import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open } from "../src/store/db.js";
import { chunkDocument, headingLevel, overlapTail } from "../src/rag/chunk.js";
import { normalize, withPrefix } from "../src/rag/embed.js";
import {
  ExtractError,
  docxXmlToText,
  extractDocument,
  joinTextItems,
  kindFor,
} from "../src/rag/extract.js";
import { excerpt, fuse, topMatches } from "../src/rag/search.js";
import {
  createCollection,
  createDocument,
  deleteDocument,
  getChunks,
  insertChunks,
  keywordMatches,
  listCollections,
  loadVectors,
  toFtsQuery,
} from "../src/rag/store.js";
import { ZipError, listZipEntries, readZipEntry } from "../src/rag/zip.js";
import { resolveCollection } from "../src/agent/tools/knowledge.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

let database: DatabaseSync;
beforeEach(() => {
  database = open(":memory:");
});
afterEach(() => {
  database.close();
});

// -- ZIP ----------------------------------------------------------------------

describe("zip okuyucu", () => {
  const docx = () => fs.readFileSync(path.join(FIXTURES, "rapor.docx"));

  it("gerçek bir DOCX arşivinin girdilerini listeler", () => {
    const names = listZipEntries(docx()).map((entry) => entry.name);
    expect(names).toContain("word/document.xml");
    expect(names).toContain("[Content_Types].xml");
  });

  it("sıkıştırılmış girdiyi açar", () => {
    const xml = readZipEntry(docx(), "word/document.xml");
    expect(xml).not.toBeNull();
    expect(xml?.toString("utf8")).toContain("<w:t");
  });

  it("olmayan girdi için null döner", () => {
    expect(readZipEntry(docx(), "yok/olan.xml")).toBeNull();
  });

  it("ZIP olmayan dosyayı reddeder", () => {
    expect(() => listZipEntries(Buffer.from("bu bir zip degil"))).toThrow(ZipError);
  });

  it("bozuk merkezi dizini sessizce yutmaz", () => {
    const broken = docx();
    // Merkezi dizin imzasını bozmak ayrıştırmayı hataya düşürmeli.
    const marker = broken.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(marker).toBeGreaterThan(0);
    broken[marker + 1] = 0x00;
    expect(() => listZipEntries(broken)).toThrow(ZipError);
  });

  it("desteklenmeyen sıkıştırma yöntemini bildirir", () => {
    // Yöntem 12 (bzip2) ile tek girdilik arşiv.
    const archive = buildZip("a.txt", Buffer.from("veri"), 12);
    expect(() => readZipEntry(archive, "a.txt")).toThrow(/Desteklenmeyen sıkıştırma/);
  });
});

/** Test için elde ZIP kurar; yalnızca yöntem alanını denetlemek gerektiğinde. */
function buildZip(name: string, data: Buffer, method: number): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  const centralOffset = local.length + nameBytes.length + data.length;
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]);
}

// -- Çıkarma ------------------------------------------------------------------

describe("belge çıkarma", () => {
  it("gerçek bir PDF'ten sayfa sayfa metin çıkarır", async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, "rapor.pdf"));
    const document = await extractDocument("rapor.pdf", bytes);
    expect(document.kind).toBe("pdf");
    expect(document.pages.length).toBeGreaterThan(1);

    const page = document.pages.find((entry) => entry.text.includes("KRITIK OLGU"));
    expect(page).toBeDefined();
    // Kaynak gösteriminin dayanağı: olgunun hangi sayfada olduğu.
    expect(page?.page).toBe(4);
    expect(page?.text).toContain("saniyede 97.6 parcadir");
  });

  it("gerçek bir DOCX'ten metin çıkarır", async () => {
    const bytes = fs.readFileSync(path.join(FIXTURES, "rapor.docx"));
    const document = await extractDocument("rapor.docx", bytes);
    expect(document.kind).toBe("docx");
    expect(document.pages[0]?.text).toContain("KRITIK OLGU");
  });

  it("desteklenmeyen türü açıkça reddeder", async () => {
    await expect(extractDocument("resim.png", Buffer.from("x"))).rejects.toThrow(
      ExtractError,
    );
  });

  it("ikili dosyayı metin diye okumaya çalışmaz", async () => {
    const binary = Buffer.from([0x41, 0x00, 0x42, 0x00]);
    await expect(extractDocument("veri.txt", binary)).rejects.toThrow(/ikili/);
  });

  it("uzantıdan tür belirler", () => {
    expect(kindFor("a.PDF")).toBe("pdf");
    expect(kindFor("notlar.md")).toBe("markdown");
    expect(kindFor("index.ts")).toBe("code");
    expect(kindFor("arsiv.zip")).toBeNull();
  });
});

describe("PDF metin birleştirme", () => {
  const item = (str: string, x: number, width: number, extra = {}) => ({
    str,
    width,
    height: 10,
    transform: [10, 0, 0, 10, x, 700],
    ...extra,
  });

  it("aralık varsa boşluk koyar, yoksa birleştirir", () => {
    // "mo" + "del" bitişik (kerning), sonra aralıklı "yuklendi".
    const text = joinTextItems([
      item("mo", 0, 20),
      item("del", 20, 30),
      item("yuklendi", 60, 60),
    ]);
    expect(text).toBe("model yuklendi");
  });

  it("satır sonunu satır başı yapar", () => {
    const text = joinTextItems([
      item("ilk", 0, 20, { hasEOL: true }),
      item("ikinci", 0, 30),
    ]);
    expect(text).toBe("ilk\nikinci");
  });

  it("y ekseni değişince satır atar", () => {
    const text = joinTextItems([
      { str: "ust", width: 20, height: 10, transform: [10, 0, 0, 10, 0, 700] },
      { str: "alt", width: 20, height: 10, transform: [10, 0, 0, 10, 0, 680] },
    ]);
    expect(text).toBe("ust\nalt");
  });

  it("satır sonu tirelemesini birleştirir", () => {
    const text = joinTextItems([
      { str: "kul-", width: 20, height: 10, transform: [10, 0, 0, 10, 0, 700], hasEOL: true },
      { str: "lanim", width: 20, height: 10, transform: [10, 0, 0, 10, 0, 680] },
    ]);
    expect(text).toBe("kullanim");
  });
});

describe("DOCX XML", () => {
  it("paragrafları satır sonuna çevirir", () => {
    const xml = "<w:p><w:r><w:t>bir</w:t></w:r></w:p><w:p><w:r><w:t>iki</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("bir\niki");
  });

  it("XML varlıklarını çözer", () => {
    const xml = '<w:p><w:t xml:space="preserve">a &amp; b &#231; &lt;x&gt;</w:t></w:p>';
    expect(docxXmlToText(xml)).toBe("a & b ç <x>");
  });

  it("alan kodlarını metne karıştırmaz", () => {
    const xml =
      "<w:p><w:instrText>HYPERLINK http://ornek</w:instrText><w:t>baglanti</w:t></w:p>";
    expect(docxXmlToText(xml)).toBe("baglanti");
  });

  it("sekme ve satır atlamayı korur", () => {
    const xml = "<w:p><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:p>";
    expect(docxXmlToText(xml)).toBe("a\tb\nc");
  });
});

// -- Parçalama ----------------------------------------------------------------

describe("parçalama", () => {
  const doc = (text: string, kind: "markdown" | "text" = "text") => ({
    kind,
    title: "",
    pages: [{ page: 1, text }],
  });

  it("markdown başlık yolunu parçaya yazar", () => {
    const chunks = chunkDocument(
      doc("# Kurulum\n\nIlk adim.\n\n## Gereksinimler\n\nNode 24 gerekir.", "markdown"),
    );
    const nested = chunks.find((chunk) => chunk.text.includes("Node 24"));
    expect(nested?.heading).toBe("Kurulum › Gereksinimler");
  });

  it("sayfa numarasını korur", () => {
    const chunks = chunkDocument({
      kind: "pdf",
      title: "",
      pages: [
        { page: 1, text: "ilk sayfa" },
        { page: 7, text: "yedinci sayfa" },
      ],
    });
    expect(chunks.map((chunk) => chunk.page)).toEqual([1, 7]);
  });

  it("üst sınırı aşmaz", () => {
    const long = "cumle burada. ".repeat(2000);
    const chunks = chunkDocument(doc(long), { targetChars: 500, maxChars: 800 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(1200);
  });

  it("sayfa sınırını aşan parça üretmez", () => {
    const chunks = chunkDocument({
      kind: "pdf",
      title: "",
      pages: [
        { page: 1, text: "birinci sayfanin metni" },
        { page: 2, text: "ikinci sayfanin metni" },
      ],
    });
    for (const chunk of chunks) {
      const merged = chunk.text.includes("birinci") && chunk.text.includes("ikinci");
      expect(merged).toBe(false);
    }
  });

  it("başlık satırını tanır", () => {
    expect(headingLevel("### Baslik")).toBe(3);
    expect(headingLevel("#etiket")).toBe(0);
    expect(headingLevel("normal satir")).toBe(0);
  });

  it("örtüşmeyi cümle sınırından alır", () => {
    const tail = overlapTail("Ilk cumle. Ikinci cumle burada.", 20);
    expect(tail.startsWith("Ikinci")).toBe(true);
  });

  it("boş belgede parça üretmez", () => {
    expect(chunkDocument(doc("   \n\n  "))).toEqual([]);
  });
});

// -- Gömme --------------------------------------------------------------------

describe("gömme yardımcıları", () => {
  it("vektörü birim uzunluğa getirir", () => {
    const unit = normalize(Float32Array.from([3, 4]));
    expect(unit[0]).toBeCloseTo(0.6, 5);
    expect(unit[1]).toBeCloseTo(0.8, 5);
  });

  it("sıfır vektörde bölme yapmaz", () => {
    const zero = normalize(Float32Array.from([0, 0]));
    expect([...zero]).toEqual([0, 0]);
  });

  it("model ailesine göre önek ekler", () => {
    expect(withPrefix("nomic-embed-text-v1.5", "abc", "query")).toBe("search_query: abc");
    expect(withPrefix("nomic-embed-text-v1.5", "abc", "document")).toBe(
      "search_document: abc",
    );
    expect(withPrefix("multilingual-e5-large", "abc", "query")).toBe("query: abc");
    expect(withPrefix("bge-m3", "abc", "query")).toBe("abc");
  });
});

// -- Arama --------------------------------------------------------------------

describe("arama", () => {
  it("iç çarpımla en yakınları sıralar", () => {
    const vectors = {
      ids: ["a", "b", "c"],
      dimensions: 2,
      data: Float32Array.from([1, 0, 0, 1, 0.7071, 0.7071]),
    };
    const hits = topMatches(vectors, Float32Array.from([1, 0]), 2);
    expect(hits.map((hit) => hit.id)).toEqual(["a", "c"]);
  });

  it("boş koleksiyonda çökmez", () => {
    const empty = { ids: [], dimensions: 0, data: new Float32Array(0) };
    expect(topMatches(empty, Float32Array.from([1, 0]), 5)).toEqual([]);
  });

  it("iki listede de geçen sonucu öne alır", () => {
    const fused = fuse(["a", "b", "c"], ["c", "d"]);
    expect(fused[0]?.id).toBe("c");
    expect(fused[0]?.matchedBy).toBe("both");
  });

  it("alıntıyı eşleşen terimin çevresinden alır", () => {
    const text = `${"dolgu ".repeat(200)}uretim hizi saniyede 97.6 parca${"son ".repeat(200)}`;
    const snippet = excerpt(text, "uretim hizi nedir");
    expect(snippet).toContain("97.6");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("eşleşme yoksa parçanın başını gösterir", () => {
    const text = "a".repeat(1000);
    expect(excerpt(text, "bulunamaz").startsWith("aaa")).toBe(true);
  });

  it("kısa parçayı kırpmaz", () => {
    expect(excerpt("kisa metin", "metin")).toBe("kisa metin");
  });

  it("tek listede geçeni kaynağıyla işaretler", () => {
    const fused = fuse(["a"], ["b"]);
    expect(fused.find((entry) => entry.id === "a")?.matchedBy).toBe("semantic");
    expect(fused.find((entry) => entry.id === "b")?.matchedBy).toBe("keyword");
  });
});

// -- Depo ---------------------------------------------------------------------

describe("bilgi tabanı deposu", () => {
  const seed = () => {
    const collection = createCollection(
      { name: "Kilavuz", embedProvider: "llamacpp", embedModel: "nomic" },
      database,
    );
    const document = createDocument(
      { collectionId: collection.id, name: "rapor.pdf", kind: "pdf", sizeBytes: 10 },
      database,
    );
    insertChunks(
      collection.id,
      document.id,
      [
        {
          seq: 0, page: 4, heading: "", text: "akis hizi saniyede 97.6 parca",
          embedding: Float32Array.from([1, 0]),
        },
        {
          seq: 1, page: 5, heading: "Ekler", text: "bellek butcesi hesabi",
          embedding: Float32Array.from([0, 1]),
        },
      ],
      database,
    );
    return { collection, document };
  };

  it("koleksiyon ve belge sayılarını birlikte döner", () => {
    seed();
    const [collection] = listCollections(database);
    expect(collection?.documentCount).toBe(1);
    expect(collection?.chunkCount).toBe(2);
  });

  it("vektörleri düz dizi olarak geri okur", () => {
    const { collection } = seed();
    const vectors = loadVectors(collection.id, database);
    expect(vectors.dimensions).toBe(2);
    expect(vectors.ids.length).toBe(2);
    expect([...vectors.data]).toEqual([1, 0, 0, 1]);
  });

  it("parçaları belge adıyla birlikte verir", () => {
    const { collection } = seed();
    const vectors = loadVectors(collection.id, database);
    const chunks = getChunks(vectors.ids, database);
    expect(chunks.get(vectors.ids[0] as string)?.documentName).toBe("rapor.pdf");
    expect(chunks.get(vectors.ids[0] as string)?.page).toBe(4);
  });

  it("tam metin araması birebir terimi bulur", () => {
    const { collection } = seed();
    const ids = keywordMatches(collection.id, "97.6", 5, database);
    expect(ids.length).toBe(1);
    const chunk = getChunks(ids, database).get(ids[0] as string);
    expect(chunk?.page).toBe(4);
  });

  it("kullanıcı metnini FTS sözdizimi olarak yorumlamaz", () => {
    const { collection } = seed();
    // Tırnak ve operatör içeren girdi hata vermemeli.
    expect(() =>
      keywordMatches(collection.id, 'bellek" OR NEAR(x', 5, database),
    ).not.toThrow();
    expect(toFtsQuery('bellek "OR" NEAR')).toBe('"bellek" OR "OR" OR "NEAR"');
    // Tek harfli belirteçler gürültü; FTS'te eleme yapmaz, sıralamayı bozar.
    expect(toFtsQuery("a b c")).toBe("");
    expect(toFtsQuery("!!")).toBe("");
  });

  it("belge silinince parçaları da gider", () => {
    const { collection, document } = seed();
    deleteDocument(document.id, database);
    expect(loadVectors(collection.id, database).ids.length).toBe(0);
    expect(keywordMatches(collection.id, "bellek", 5, database)).toEqual([]);
  });
});

describe("ajan koleksiyon çözümlemesi", () => {
  const collections = [
    { id: "1", name: "Şirket İçi", chunkCount: 3 },
    { id: "2", name: "Ürün Kılavuzu", chunkCount: 5 },
  ] as never as Parameters<typeof resolveCollection>[0];

  it("tek koleksiyon varsa onu seçer", () => {
    expect(resolveCollection([collections[0] as never], undefined)?.id).toBe("1");
  });

  it("tek koleksiyonda uydurma ada takılmaz", () => {
    // Model bu alanı uydurur; belirsizlik yokken aramayı reddetmek
    // kullanıcıya cevapsızlık olarak döner.
    expect(
      resolveCollection([collections[0] as never], "kullanicinin_belgeleri")?.id,
    ).toBe("1");
  });

  it("birden fazla varsa ad olmadan seçmez", () => {
    expect(resolveCollection(collections, undefined)).toBeNull();
  });

  it("Türkçe büyük/küçük harfe takılmaz", () => {
    expect(resolveCollection(collections, "ürün kılavuzu")?.id).toBe("2");
    expect(resolveCollection(collections, "ŞİRKET İÇİ")?.id).toBe("1");
  });
});

describe("sıkıştırma yardımcısı", () => {
  it("deflate edilmiş girdiyi açar", () => {
    const payload = Buffer.from("merhaba dunya", "utf8");
    const archive = buildZip("m.txt", zlib.deflateRawSync(payload), 8);
    expect(readZipEntry(archive, "m.txt")?.toString("utf8")).toBe("merhaba dunya");
  });
});
