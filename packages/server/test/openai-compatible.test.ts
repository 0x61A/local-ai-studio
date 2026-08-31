import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ToolCallAccumulator,
  normalizeFinishReason,
  streamOpenAiCompatible,
  toWireMessage,
} from "../src/providers/openai-compatible.js";
import { ProviderError, type ChatEvent } from "../src/providers/types.js";

describe("ToolCallAccumulator", () => {
  it("parçalanmış argümanları birleştirir", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ index: 0, id: "call_1", function: { name: "hava_durumu", arguments: "" } }]);
    acc.absorb([{ index: 0, function: { arguments: '{"sehir"' } }]);
    acc.absorb([{ index: 0, function: { arguments: ':"İstanbul"}' } }]);
    expect(acc.drain()).toEqual([
      { id: "call_1", name: "hava_durumu", arguments: '{"sehir":"İstanbul"}' },
    ]);
  });

  it("paralel çağrıları index'e göre ayırır", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([
      { index: 0, id: "a", function: { name: "bir", arguments: "{" } },
      { index: 1, id: "b", function: { name: "iki", arguments: "{" } },
    ]);
    acc.absorb([
      { index: 1, function: { arguments: '"y":2}' } },
      { index: 0, function: { arguments: '"x":1}' } },
    ]);
    expect(acc.drain()).toEqual([
      { id: "a", name: "bir", arguments: '{"x":1}' },
      { id: "b", name: "iki", arguments: '{"y":2}' },
    ]);
  });

  it("parçalanmış ad parçalarını birleştirir", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ index: 0, id: "x", function: { name: "dosya_" } }]);
    acc.absorb([{ index: 0, function: { name: "oku" } }]);
    expect(acc.drain()[0]?.name).toBe("dosya_oku");
  });

  it("id göndermeyen yerel motorlar için id üretir", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ index: 2, function: { name: "araç", arguments: "{}" } }]);
    expect(acc.drain()[0]?.id).toBe("call_2");
  });

  it("argümansız çağrıyı boş nesneye çevirir", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ index: 0, id: "a", function: { name: "şimdi" } }]);
    expect(acc.drain()[0]?.arguments).toBe("{}");
  });

  it("adsız yarım kaydı atar", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ index: 0, function: { arguments: "{}" } }]);
    expect(acc.drain()).toEqual([]);
  });

  it("drain sonrası tamponu boşaltır", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ index: 0, id: "a", function: { name: "x", arguments: "{}" } }]);
    expect(acc.drain()).toHaveLength(1);
    expect(acc.drain()).toEqual([]);
  });

  it("index alanı hiç gelmezse 0 varsayar", () => {
    const acc = new ToolCallAccumulator();
    acc.absorb([{ id: "a", function: { name: "x", arguments: '{"a"' } }]);
    acc.absorb([{ function: { arguments: ":1}" } }]);
    expect(acc.drain()).toEqual([{ id: "a", name: "x", arguments: '{"a":1}' }]);
  });
});

describe("normalizeFinishReason", () => {
  it("araç çağrısı görüldüyse tool_calls döner", () => {
    expect(normalizeFinishReason("stop", true)).toBe("tool_calls");
  });
  it("bilinen değerleri eşler", () => {
    expect(normalizeFinishReason("length", false)).toBe("length");
    expect(normalizeFinishReason("max_tokens", false)).toBe("length");
    expect(normalizeFinishReason("content_filter", false)).toBe("content_filter");
    expect(normalizeFinishReason("function_call", false)).toBe("tool_calls");
  });
  it("bilinmeyeni stop'a düşürür", () => {
    expect(normalizeFinishReason("bilinmeyen", false)).toBe("stop");
  });
});

describe("toWireMessage", () => {
  it("düz metin mesajını geçirir", () => {
    expect(toWireMessage({ role: "user", content: "merhaba" })).toEqual({
      role: "user",
      content: "merhaba",
    });
  });

  it("araç yanıtını tool_call_id ile eşler", () => {
    expect(
      toWireMessage({ role: "tool", content: "22 derece", toolCallId: "call_1" }),
    ).toEqual({ role: "tool", tool_call_id: "call_1", content: "22 derece" });
  });

  it("assistant araç çağrılarını tele çevirir", () => {
    const wire = toWireMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "ara", arguments: '{"q":"x"}' }],
    });
    expect(wire["tool_calls"]).toEqual([
      { id: "c1", type: "function", function: { name: "ara", arguments: '{"q":"x"}' } },
    ]);
  });

  it("görseli data URL'ye çevirir", () => {
    const wire = toWireMessage({
      role: "user",
      content: [
        { type: "text", text: "bu ne" },
        { type: "image", imageBase64: "AAAA", mimeType: "image/jpeg" },
      ],
    });
    expect(wire["content"]).toEqual([
      { type: "text", text: "bu ne" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
    ]);
  });
});

// -- Akış bütünü --------------------------------------------------------------

function sseResponse(lines: string[], init: ResponseInit = {}): Response {
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
    ...init,
  });
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const CONFIG = { baseUrl: "http://127.0.0.1:9999/v1", apiKey: "test" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamOpenAiCompatible", () => {
  it("metin parçalarını ve bitişi verir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Mer"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"haba"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(
      streamOpenAiCompatible(CONFIG, [{ role: "user", content: "selam" }], {
        model: "test",
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Mer" },
      { type: "text", delta: "haba" },
      { type: "done", finishReason: "stop" },
    ]);
  });

  it("akıl yürütme alanının iki adını da tanır", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"düşünüyorum"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"hâlâ"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(
      streamOpenAiCompatible(CONFIG, [], { model: "test" }),
    );
    expect(events.filter((e) => e.type === "reasoning")).toEqual([
      { type: "reasoning", delta: "düşünüyorum" },
      { type: "reasoning", delta: "hâlâ" },
    ]);
  });

  it("parçalanmış araç çağrısını tek olayda toplar", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ara","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"q\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"kedi\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(
      streamOpenAiCompatible(CONFIG, [], { model: "test" }),
    );
    expect(events).toEqual([
      { type: "tool_call", call: { id: "c1", name: "ara", arguments: '{"q":"kedi"}' } },
      { type: "done", finishReason: "tool_calls" },
    ]);
  });

  it("kullanım bilgisini iletir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(
      streamOpenAiCompatible(CONFIG, [], { model: "test" }),
    );
    expect(events[0]).toEqual({ type: "usage", promptTokens: 12, completionTokens: 34 });
  });

  it("bozuk JSON parçasını atlar, akışı kesmez", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse([
        "data: {bozuk json\n\n",
        'data: {"choices":[{"delta":{"content":"devam"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const events = await collect(
      streamOpenAiCompatible(CONFIG, [], { model: "test" }),
    );
    expect(events).toContainEqual({ type: "text", delta: "devam" });
  });

  it("HTTP hatasını anlaşılır ProviderError'a çevirir", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "Geçersiz anahtar" } }), {
        status: 401,
      }),
    );
    await expect(
      collect(streamOpenAiCompatible(CONFIG, [], { model: "test" })),
    ).rejects.toThrow(/401.*Geçersiz anahtar.*API anahtarını kontrol edin/s);
  });

  it("429'u yeniden denenebilir işaretler, 400'ü işaretlemez", async () => {
    for (const [status, retriable] of [[429, true], [400, false]] as const) {
      vi.stubGlobal("fetch", async () => new Response("{}", { status }));
      const error = await collect(
        streamOpenAiCompatible(CONFIG, [], { model: "test" }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).retriable).toBe(retriable);
    }
  });

  it("akış içindeki hata nesnesini yükseltir", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse(['data: {"error":{"message":"bağlam doldu"}}\n\n']),
    );
    await expect(
      collect(streamOpenAiCompatible(CONFIG, [], { model: "test" })),
    ).rejects.toThrow("bağlam doldu");
  });

  it("araç tanımlarını istek gövdesine koyar", async () => {
    let sent: unknown = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return sseResponse(["data: [DONE]\n\n"]);
    });
    await collect(
      streamOpenAiCompatible(CONFIG, [], { model: "test" }, [
        {
          name: "dosya_oku",
          description: "Dosya okur",
          parameters: { type: "object", properties: { yol: { type: "string" } } },
        },
      ]),
    );
    expect((sent as { tools: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "dosya_oku",
          description: "Dosya okur",
          parameters: { type: "object", properties: { yol: { type: "string" } } },
        },
      },
    ]);
  });

  it("anahtar verilmezse authorization başlığı göndermez (yerel motor)", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return sseResponse(["data: [DONE]\n\n"]);
    });
    await collect(
      streamOpenAiCompatible({ baseUrl: "http://127.0.0.1:1/v1" }, [], {
        model: "yerel",
      }),
    );
    expect(headers["authorization"]).toBeUndefined();
  });
});
