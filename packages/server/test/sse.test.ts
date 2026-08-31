import { describe, expect, it } from "vitest";
import { SseParser, readSseStream } from "../src/providers/sse.js";

describe("SseParser", () => {
  it("tek olayı ayrıştırır", () => {
    const parser = new SseParser();
    expect(parser.push("data: merhaba\n\n")).toEqual([
      { event: "message", data: "merhaba" },
    ]);
  });

  it("bir parçadaki birden çok olayı ayırır", () => {
    const parser = new SseParser();
    const events = parser.push("data: bir\n\ndata: iki\n\ndata: üç\n\n");
    expect(events.map((e) => e.data)).toEqual(["bir", "iki", "üç"]);
  });

  it("parça sınırında bölünmüş olayı birleştirir", () => {
    const parser = new SseParser();
    expect(parser.push("data: mer")).toEqual([]);
    expect(parser.push("haba dün")).toEqual([]);
    expect(parser.push("ya\n\n")).toEqual([{ event: "message", data: "merhaba dünya" }]);
  });

  it("ayırıcı satırın ortasında bölünmeyi kaldırır", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\n")).toEqual([]);
    expect(parser.push("\ndata: y\n\n")).toEqual([
      { event: "message", data: "x" },
      { event: "message", data: "y" },
    ]);
  });

  it("event ve id alanlarını okur", () => {
    const parser = new SseParser();
    expect(parser.push("event: tool_call\nid: 42\ndata: {}\n\n")).toEqual([
      { event: "tool_call", data: "{}", id: "42" },
    ]);
  });

  it("çok satırlı data'yı satır sonuyla birleştirir", () => {
    const parser = new SseParser();
    expect(parser.push("data: birinci\ndata: ikinci\n\n")[0]?.data).toBe(
      "birinci\nikinci",
    );
  });

  it("yorum satırlarını (keepalive) atlar", () => {
    const parser = new SseParser();
    expect(parser.push(": ping\n\n")).toEqual([]);
    expect(parser.push(": ping\ndata: gerçek\n\n")).toEqual([
      { event: "message", data: "gerçek" },
    ]);
  });

  it("CRLF satır sonlarını kabul eder", () => {
    const parser = new SseParser();
    expect(parser.push("data: windows\r\n\r\n")).toEqual([
      { event: "message", data: "windows" },
    ]);
  });

  it("iki noktadan sonra yalnızca tek boşluk atar", () => {
    const parser = new SseParser();
    expect(parser.push("data:  iki boşluk\n\n")[0]?.data).toBe(" iki boşluk");
    expect(parser.push("data:boşluksuz\n\n")[0]?.data).toBe("boşluksuz");
  });

  it("flush() tamponda kalan yarım olayı verir", () => {
    const parser = new SseParser();
    parser.push("data: son olay ayırıcısız");
    expect(parser.flush()).toEqual([{ event: "message", data: "son olay ayırıcısız" }]);
    expect(parser.flush()).toEqual([]);
  });

  it("JSON gövdesindeki çift satır sonunu bozmaz", () => {
    const parser = new SseParser();
    const payload = JSON.stringify({ text: "satır1\n\nsatır2" });
    expect(parser.push(`data: ${payload}\n\n`)[0]?.data).toBe(payload);
  });
});

describe("readSseStream", () => {
  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it("akıştan olayları sırayla verir", async () => {
    const encoder = new TextEncoder();
    const stream = streamOf([
      encoder.encode("data: bir\n\ndata: "),
      encoder.encode("iki\n\n"),
    ]);
    const seen: string[] = [];
    for await (const event of readSseStream(stream)) seen.push(event.data);
    expect(seen).toEqual(["bir", "iki"]);
  });

  it("parça sınırında bölünen UTF-8 karakteri bozmaz", async () => {
    // "ş" iki bayt (0xC5 0x9F); parçayı tam ortasından bölüyoruz.
    const full = new TextEncoder().encode("data: çalışıyor\n\n");
    const splitAt = full.indexOf(0xc5); // "ş"in ilk baytı
    expect(splitAt).toBeGreaterThan(0);
    const stream = streamOf([full.slice(0, splitAt + 1), full.slice(splitAt + 1)]);
    const seen: string[] = [];
    for await (const event of readSseStream(stream)) seen.push(event.data);
    expect(seen).toEqual(["çalışıyor"]);
  });

  it("ayırıcısız biten son olayı da verir", async () => {
    const stream = streamOf([new TextEncoder().encode("data: yarım")]);
    const seen: string[] = [];
    for await (const event of readSseStream(stream)) seen.push(event.data);
    expect(seen).toEqual(["yarım"]);
  });
});
