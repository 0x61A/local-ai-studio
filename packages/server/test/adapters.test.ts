import { afterEach, describe, expect, it, vi } from "vitest";
import { mapStopReason, splitSystem, streamAnthropic } from "../src/providers/anthropic.js";
import { mapFinishReason, streamGemini, toGeminiContents } from "../src/providers/gemini.js";
import type { ChatEvent, ChatMessage } from "../src/providers/types.js";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

afterEach(() => vi.unstubAllGlobals());

// -- Anthropic ----------------------------------------------------------------

describe("Anthropic: mesaj dönüşümü", () => {
  it("sistem istemini gövdenin tepesine ayırır", () => {
    const { system, turns } = splitSystem([
      { role: "system", content: "Sen yardımcısın." },
      { role: "user", content: "merhaba" },
    ]);
    expect(system).toBe("Sen yardımcısın.");
    expect(turns).toEqual([{ role: "user", content: [{ type: "text", text: "merhaba" }] }]);
  });

  it("birden çok sistem mesajını birleştirir", () => {
    const { system } = splitSystem([
      { role: "system", content: "Kural bir." },
      { role: "system", content: "Kural iki." },
      { role: "user", content: "x" },
    ]);
    expect(system).toBe("Kural bir.\n\nKural iki.");
  });

  it("araç sonucunu user içerik bloğuna çevirir", () => {
    const { turns } = splitSystem([
      { role: "tool", content: "22 derece", toolCallId: "tu_1" },
    ]);
    expect(turns[0]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "22 derece" }],
    });
  });

  it("assistant araç çağrısını tool_use bloğuna çevirir", () => {
    const { turns } = splitSystem([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tu_1", name: "hava", arguments: '{"sehir":"Ankara"}' }],
      },
    ]);
    expect(turns[0]?.["content"]).toEqual([
      { type: "tool_use", id: "tu_1", name: "hava", input: { sehir: "Ankara" } },
    ]);
  });

  it("bozuk araç argümanını boş nesneye düşürür, patlamaz", () => {
    const { turns } = splitSystem([
      { role: "assistant", content: "", toolCalls: [{ id: "t", name: "x", arguments: "{bozuk" }] },
    ]);
    expect((turns[0]?.["content"] as Array<{ input: unknown }>)[0]?.input).toEqual({});
  });

  it("boş içeriği reddedilmeyecek biçime getirir", () => {
    const { turns } = splitSystem([{ role: "user", content: "" }]);
    expect(turns[0]?.["content"]).toEqual([{ type: "text", text: "" }]);
  });

  it("görseli base64 source bloğuna çevirir", () => {
    const { turns } = splitSystem([
      { role: "user", content: [{ type: "image", imageBase64: "QUJD", mimeType: "image/webp" }] },
    ]);
    expect(turns[0]?.["content"]).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "QUJD" } },
    ]);
  });

  it("stop_reason eşlemesi", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("refusal")).toBe("content_filter");
  });
});

describe("Anthropic: akış", () => {
  const config = { apiKey: "test", baseUrl: "http://127.0.0.1:9/v1" };

  it("metin ve düşünme parçalarını ayırır", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"düşünüyorum"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Merhaba"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      ]),
    );
    expect(await collect(streamAnthropic(config, [], { model: "m" }))).toEqual([
      { type: "reasoning", delta: "düşünüyorum" },
      { type: "text", delta: "Merhaba" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("input_json_delta parçalarını tek araç çağrısında toplar", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":"ara"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"kedi\\"}"}}\n\n',
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      ]),
    );
    expect(await collect(streamAnthropic(config, [], { model: "m" }))).toEqual([
      { type: "tool_call", call: { id: "tu_1", name: "ara", arguments: '{"q":"kedi"}' } },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });

  it("max_tokens'ı her zaman gönderir (zorunlu alan)", async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return sseResponse([]);
    });
    await collect(streamAnthropic(config, [], { model: "m" }));
    expect(sent["max_tokens"]).toBe(4096);
  });

  it("anahtarı x-api-key başlığında yollar", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return sseResponse([]);
    });
    await collect(streamAnthropic(config, [], { model: "m" }));
    expect(headers["x-api-key"]).toBe("test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("akış içindeki hatayı yükseltir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse(['data: {"type":"error","error":{"message":"aşırı yük","type":"overloaded_error"}}\n\n']),
    );
    await expect(collect(streamAnthropic(config, [], { model: "m" }))).rejects.toThrow(
      "aşırı yük",
    );
  });
});

// -- Gemini -------------------------------------------------------------------

describe("Gemini: mesaj dönüşümü", () => {
  it("rolleri user/model'e eşler", () => {
    const { contents } = toGeminiContents([
      { role: "user", content: "soru" },
      { role: "assistant", content: "cevap" },
    ]);
    expect(contents.map((c) => c["role"])).toEqual(["user", "model"]);
  });

  it("sistem istemini ayırır", () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: "system", content: "Kısa cevap ver." },
      { role: "user", content: "x" },
    ]);
    expect(systemInstruction).toBe("Kısa cevap ver.");
    expect(contents).toHaveLength(1);
  });

  it("araç sonucunu functionResponse'a çevirir", () => {
    const { contents } = toGeminiContents([
      { role: "tool", content: "sonuç", name: "ara", toolCallId: "c1" },
    ]);
    expect(contents[0]?.["parts"]).toEqual([
      { functionResponse: { name: "ara", response: { result: "sonuç" } } },
    ]);
  });

  it("görseli inlineData'ya çevirir", () => {
    const { contents } = toGeminiContents([
      { role: "user", content: [{ type: "image", imageBase64: "QQ==", mimeType: "image/png" }] },
    ]);
    expect(contents[0]?.["parts"]).toEqual([
      { inlineData: { mimeType: "image/png", data: "QQ==" } },
    ]);
  });

  it("finishReason eşlemesi", () => {
    expect(mapFinishReason("MAX_TOKENS")).toBe("length");
    expect(mapFinishReason("SAFETY")).toBe("content_filter");
    expect(mapFinishReason("STOP")).toBe("stop");
  });
});

describe("Gemini: akış", () => {
  const config = { apiKey: "gizli", baseUrl: "http://127.0.0.1:9/v1beta" };

  it("metin parçalarını verir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Mer"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"haba"}]},"finishReason":"STOP"}]}\n\n',
      ]),
    );
    expect(await collect(streamGemini(config, [], { model: "gemini-x" }))).toEqual([
      { type: "text", delta: "Mer" },
      { type: "text", delta: "haba" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("functionCall'ı araç çağrısına çevirir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"ara","args":{"q":"kedi"}}}]}}]}\n\n',
      ]),
    );
    expect(await collect(streamGemini(config, [], { model: "g" }))).toEqual([
      { type: "tool_call", call: { id: "call_1", name: "ara", arguments: '{"q":"kedi"}' } },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });

  it("düşünme parçasını metinden ayırır", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"plan","thought":true},{"text":"cevap"}]}}]}\n\n',
      ]),
    );
    const events = await collect(streamGemini(config, [], { model: "g" }));
    expect(events).toContainEqual({ type: "reasoning", delta: "plan" });
    expect(events).toContainEqual({ type: "text", delta: "cevap" });
  });

  it("anahtarı başlıkta yollar, URL'ye koymaz", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return sseResponse([]);
    });
    await collect(streamGemini(config, [], { model: "gemini-2.0" }));
    expect(url).not.toContain("gizli");
    expect(headers["x-goog-api-key"]).toBe("gizli");
  });

  it("kullanım bilgisini iletir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":9},"candidates":[]}\n\n',
      ]),
    );
    expect(await collect(streamGemini(config, [], { model: "g" }))).toContainEqual({
      type: "usage",
      promptTokens: 7,
      completionTokens: 9,
    });
  });
});
