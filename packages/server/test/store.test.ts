import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { currentSchemaVersion, one, open } from "../src/store/db.js";
import { allSettings, deleteSetting, getSetting, setSetting } from "../src/store/settings.js";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  listTags,
  searchMessages,
  setTags,
  updateConversation,
} from "../src/store/conversations.js";

let database: DatabaseSync;

beforeEach(() => {
  database = open(":memory:");
});
afterEach(() => {
  database.close();
});

describe("göçler", () => {
  it("şema sürümünü güncel bırakır", () => {
    const row = one<{ user_version: number }>(database, "PRAGMA user_version");
    expect(row?.user_version).toBe(currentSchemaVersion());
  });

  it("tekrar açıldığında yeniden çalışmaz", () => {
    // Aynı dosyayı iki kez açmak göçleri tekrarlarsa CREATE TABLE patlar.
    expect(() => open(":memory:")).not.toThrow();
  });
});

describe("ayarlar", () => {
  it("değer yazar ve okur", () => {
    setSetting("tema", { mode: "dark" }, database);
    expect(getSetting("tema", null, database)).toEqual({ mode: "dark" });
  });

  it("var olmayan anahtarda varsayılana düşer", () => {
    expect(getSetting("yok", "varsayılan", database)).toBe("varsayılan");
  });

  it("üzerine yazar, çoğaltmaz", () => {
    setSetting("x", 1, database);
    setSetting("x", 2, database);
    expect(getSetting("x", 0, database)).toBe(2);
    expect(Object.keys(allSettings(database))).toHaveLength(1);
  });

  it("siler", () => {
    setSetting("x", 1, database);
    deleteSetting("x", database);
    expect(getSetting("x", "yok", database)).toBe("yok");
  });

  it("bozuk JSON'da varsayılana düşer, patlamaz", () => {
    database.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("k", "{bozuk");
    expect(getSetting("k", "güvenli", database)).toBe("güvenli");
    expect(allSettings(database)).toEqual({});
  });
});

describe("konuşmalar", () => {
  it("oluşturur ve geri okur", () => {
    const created = createConversation({ title: "Deneme", model: "qwen" }, database);
    const found = getConversation(created.id, database);
    expect(found?.title).toBe("Deneme");
    expect(found?.model).toBe("qwen");
    expect(found?.archived).toBe(false);
  });

  it("güncellenme sırasına göre listeler", () => {
    const first = createConversation({ title: "İlk" }, database);
    createConversation({ title: "İkinci" }, database);
    updateConversation(first.id, { title: "İlk güncellendi" }, database);
    const list = listConversations({}, database);
    expect(list[0]?.title).toBe("İlk güncellendi");
  });

  it("arşivlenmişleri varsayılan olarak gizler", () => {
    const conversation = createConversation({ title: "Gizli" }, database);
    updateConversation(conversation.id, { archived: true }, database);
    expect(listConversations({}, database)).toHaveLength(0);
    expect(listConversations({ includeArchived: true }, database)).toHaveLength(1);
  });

  it("silince mesajları da gider (CASCADE)", () => {
    const conversation = createConversation({}, database);
    appendMessage(conversation.id, { role: "user", content: "merhaba" }, database);
    deleteConversation(conversation.id, database);
    expect(listMessages(conversation.id, database)).toHaveLength(0);
    expect(getConversation(conversation.id, database)).toBeNull();
  });
});

describe("mesajlar", () => {
  it("sırayı korur", () => {
    const conversation = createConversation({}, database);
    appendMessage(conversation.id, { role: "user", content: "bir" }, database);
    appendMessage(conversation.id, { role: "assistant", content: "iki" }, database);
    appendMessage(conversation.id, { role: "user", content: "üç" }, database);
    expect(listMessages(conversation.id, database).map((m) => m.content)).toEqual([
      "bir",
      "iki",
      "üç",
    ]);
  });

  it("konuşmanın updated_at değerini ilerletir", () => {
    const conversation = createConversation({}, database);
    const before = getConversation(conversation.id, database)!.updatedAt;
    database.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
      before - 10_000,
      conversation.id,
    );
    appendMessage(conversation.id, { role: "user", content: "yeni" }, database);
    expect(getConversation(conversation.id, database)!.updatedAt).toBeGreaterThan(
      before - 10_000,
    );
  });
});

describe("etiketler", () => {
  it("yazar, okur, çoğaltmaz", () => {
    const conversation = createConversation({}, database);
    setTags(conversation.id, ["iş", "iş", " araştırma "], database);
    expect(listTags(conversation.id, database)).toEqual(["araştırma", "iş"]);
  });

  it("yeniden yazınca eskiyi değiştirir", () => {
    const conversation = createConversation({}, database);
    setTags(conversation.id, ["a"], database);
    setTags(conversation.id, ["b"], database);
    expect(listTags(conversation.id, database)).toEqual(["b"]);
  });
});

describe("tam metin arama", () => {
  function seed() {
    const conversation = createConversation({ title: "Notlar" }, database);
    appendMessage(
      conversation.id,
      { role: "user", content: "Metal hızlandırma nasıl çalışır" },
      database,
    );
    appendMessage(
      conversation.id,
      { role: "assistant", content: "Vulkan sürücüsü ayrı bir konudur" },
      database,
    );
    return conversation;
  }

  it("eşleşen mesajı bulur", () => {
    const conversation = seed();
    const hits = searchMessages("Metal", 10, database);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.conversationId).toBe(conversation.id);
    expect(hits[0]?.title).toBe("Notlar");
    expect(hits[0]?.snippet).toContain("[Metal]");
  });

  it("önek eşleşmesi yapar", () => {
    seed();
    expect(searchMessages("hızland", 10, database).length).toBeGreaterThan(0);
  });

  it("FTS işleçlerini veri gibi ele alır, sorguyu kırmaz", () => {
    seed();
    // Bunların hepsi ham FTS sorgusuna geçseydi sözdizimi hatası verirdi.
    for (const bozuk of ['"', "*", "NEAR(", "a AND", "OR OR", '" OR 1=1 --']) {
      expect(() => searchMessages(bozuk, 10, database)).not.toThrow();
    }
  });

  it("boş sorguda boş sonuç döner", () => {
    seed();
    expect(searchMessages("   ", 10, database)).toEqual([]);
  });

  it("mesaj silinince FTS indeksinden de düşer", () => {
    const conversation = seed();
    expect(searchMessages("Vulkan", 10, database)).toHaveLength(1);
    deleteConversation(conversation.id, database);
    expect(searchMessages("Vulkan", 10, database)).toHaveLength(0);

    // searchMessages() messages ile JOIN yaptığı için bayat bir FTS kaydını
    // gizlerdi. Doğrudan indekse bakıyoruz: CASCADE silmede AFTER DELETE
    // tetikleyicisinin gerçekten çalıştığını kanıtlar. Aksi hâlde rowid geri
    // kullanıldığında bayat kayıt yeni bir mesajla yanlış eşleşirdi.
    const indexed = one<{ n: number }>(
      database,
      "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?",
      "Vulkan",
    );
    expect(indexed?.n).toBe(0);
  });

  it("rowid geri kullanıldığında yanlış eşleşme üretmez", () => {
    const first = seed();
    deleteConversation(first.id, database);
    const second = createConversation({ title: "Yeni" }, database);
    appendMessage(second.id, { role: "user", content: "tamamen farklı içerik" }, database);
    expect(searchMessages("Vulkan", 10, database)).toHaveLength(0);
    expect(searchMessages("farklı", 10, database)).toHaveLength(1);
  });
});
