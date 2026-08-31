import { describe, expect, it } from "vitest";
import { buildWhisperArgs, parseWhisperJson } from "../src/engines/whisper.js";
import { buildSayArgs, parseVoices } from "../src/audio/tts.js";

describe("whisper argümanları", () => {
  it("dil verilmezse otomatik algılar", () => {
    const args = buildWhisperArgs("/m.bin", "/a.wav", "/out");
    expect(args[args.indexOf("--language") + 1]).toBe("auto");
  });

  it("'auto' dilini olduğu gibi geçirir", () => {
    const args = buildWhisperArgs("/m.bin", "/a.wav", "/out", { language: "auto" });
    expect(args[args.indexOf("--language") + 1]).toBe("auto");
  });

  it("verilen dili kullanır", () => {
    const args = buildWhisperArgs("/m.bin", "/a.wav", "/out", { language: "tr" });
    expect(args[args.indexOf("--language") + 1]).toBe("tr");
  });

  it("çeviri istenmezse bayrağı eklemez", () => {
    expect(buildWhisperArgs("/m.bin", "/a.wav", "/out")).not.toContain("--translate");
    expect(
      buildWhisperArgs("/m.bin", "/a.wav", "/out", { translate: true }),
    ).toContain("--translate");
  });

  it("çıktıyı JSON ister ve konsolu susturur", () => {
    const args = buildWhisperArgs("/m.bin", "/a.wav", "/out");
    expect(args).toContain("--output-json");
    // Sonucu JSON'dan okuyoruz; stdout'a basılan metin yalnızca gürültü.
    expect(args).toContain("--no-prints");
  });
});

describe("whisper JSON ayrıştırma", () => {
  it("milisaniye ofsetlerini saniyeye çevirir", () => {
    const raw = JSON.stringify({
      result: { language: "tr" },
      transcription: [
        { text: " Merhaba ", offsets: { from: 0, to: 1500 } },
        { text: " dunya ", offsets: { from: 1500, to: 2800 } },
      ],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.language).toBe("tr");
    expect(parsed.text).toBe("Merhaba dunya");
    expect(parsed.segments[1]?.start).toBe(1.5);
    expect(parsed.segments[1]?.end).toBe(2.8);
  });

  it("metin zaman damgalarını da okur", () => {
    // Bazı sürümler ofset yerine "00:00:01,200" biçimi veriyor.
    const raw = JSON.stringify({
      transcription: [
        { text: "a", timestamps: { from: "00:00:01,200", to: "00:01:02,500" } },
      ],
    });
    const parsed = parseWhisperJson(raw);
    expect(parsed.segments[0]?.start).toBeCloseTo(1.2, 3);
    expect(parsed.segments[0]?.end).toBeCloseTo(62.5, 3);
  });

  it("boş segmentleri atar", () => {
    const raw = JSON.stringify({
      transcription: [{ text: "  ", offsets: { from: 0, to: 10 } }],
    });
    expect(parseWhisperJson(raw).segments).toEqual([]);
  });

  it("konuşma yoksa boş metin döner", () => {
    expect(parseWhisperJson(JSON.stringify({})).text).toBe("");
  });
});

describe("ses listesi ayrıştırma", () => {
  // `say -v '?'` çıktısının gerçek biçimi.
  const sample = [
    "Albert              en_US    # Hello! My name is Albert.",
    "Yelda               tr_TR    # Merhaba, benim adım Yelda.",
    "Flo (Fransızca (Kanada)) fr_CA    # Bonjour! Je m’appelle Flo.",
    "bozuk satir",
    "",
  ].join("\n");

  it("ad, yerel ayar ve örneği ayırır", () => {
    const voices = parseVoices(sample);
    expect(voices.length).toBe(3);
    expect(voices[0]).toEqual({
      name: "Albert",
      locale: "en_US",
      sample: "Hello! My name is Albert.",
    });
  });

  it("boşluklu ve parantezli adları bozmaz", () => {
    const flo = parseVoices(sample).find((voice) => voice.locale === "fr_CA");
    expect(flo?.name).toBe("Flo (Fransızca (Kanada))");
  });

  it("Türkçe sesi diakritikleriyle okur", () => {
    const yelda = parseVoices(sample).find((voice) => voice.name === "Yelda");
    expect(yelda?.sample).toContain("adım");
  });

  it("biçimi tutmayan satırı atlar", () => {
    expect(parseVoices("bozuk satir")).toEqual([]);
  });
});

describe("say argümanları", () => {
  it("metni argüman olarak değil dosyadan verir", () => {
    // Uzun metin argüman sınırını aşar ve argümanlar `ps` çıktısında görünür.
    const args = buildSayArgs("/tmp/t.txt", "/tmp/o.wav", null);
    expect(args[args.indexOf("-f") + 1]).toBe("/tmp/t.txt");
    expect(args).not.toContain("Merhaba");
  });

  it("tarayıcının çalabileceği WAV biçimi ister", () => {
    const args = buildSayArgs("/tmp/t.txt", "/tmp/o.wav", null);
    expect(args[args.indexOf("--data-format") + 1]).toBe("LEI16@22050");
  });

  it("ses verilmezse -v eklemez", () => {
    expect(buildSayArgs("/tmp/t.txt", "/tmp/o.wav", null)).not.toContain("-v");
    expect(buildSayArgs("/tmp/t.txt", "/tmp/o.wav", "Yelda")).toContain("Yelda");
  });

  it("aralık dışı hızı yok sayar", () => {
    expect(buildSayArgs("/t", "/o", null, 5)).not.toContain("-r");
    expect(buildSayArgs("/t", "/o", null, 9999)).not.toContain("-r");
    expect(buildSayArgs("/t", "/o", null, 200)).toContain("-r");
  });
});
