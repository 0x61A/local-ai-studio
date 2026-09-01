import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalGate } from "../src/agent/approval.js";
import { makePlan, parsePlan, runPlannedAgent } from "../src/agent/planner.js";
import { defineTool, type AgentEvent, type Tool } from "../src/agent/types.js";
import type { ChatEvent, ChatMessage, ChatProvider } from "../src/providers/types.js";

/** Önceden yazılmış turları sırayla veren sağlayıcı. */
function scriptedProvider(turns: ChatEvent[][]): ChatProvider & { seen: ChatMessage[][] } {
  let index = 0;
  const seen: ChatMessage[][] = [];
  return {
    id: "llamacpp",
    label: "test",
    capabilities: { tools: true, vision: false, embeddings: false, requiresApiKey: false },
    seen,
    isReady: async () => true,
    listModels: async () => [],
    chat: (messages) => {
      seen.push(messages.map((m) => ({ ...m })));
      const turn = turns[index] ?? [{ type: "done", finishReason: "stop" }];
      index += 1;
      return (async function* () {
        for (const event of turn) yield event;
      })();
    },
  };
}

function text(value: string): ChatEvent[] {
  return [{ type: "text", delta: value }, { type: "done", finishReason: "stop" }];
}

async function collect(events: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const noteTool: Tool<{ value: string }> = defineTool({
  name: "note",
  description: "Not alır",
  risk: "read",
  schema: z.object({ value: z.string() }),
  async run(input) {
    return { content: `not: ${input.value}` };
  },
});

function options(provider: ChatProvider) {
  return {
    provider,
    model: "test",
    messages: [
      { role: "system" as const, content: "sistem istemi" },
      { role: "user" as const, content: "raporu hazırla" },
    ],
    tools: [noteTool as Tool<never>],
    workspaceRoot: "/tmp",
    gate: new ApprovalGate(1000),
    signal: new AbortController().signal,
  };
}

describe("plan ayrıştırma", () => {
  it("düz JSON dizisini okur", () => {
    const tasks = parsePlan('[{"title":"Ara","prompt":"kaynakları ara"}]');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe("Ara");
    expect(tasks[0]?.prompt).toBe("kaynakları ara");
    expect(tasks[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("açıklama cümlesi ve ``` çiti içinden çıkarır", () => {
    const raw =
      'İşte plan:\n```json\n[{"title":"A","prompt":"a yap"},{"title":"B","prompt":"b yap"}]\n```\nUmarım olur.';
    expect(parsePlan(raw).map((task) => task.title)).toEqual(["A", "B"]);
  });

  it("prompt'u olmayan girdiyi atar", () => {
    const tasks = parsePlan('[{"title":"boş"},{"prompt":"gerçek iş"}]');
    expect(tasks).toHaveLength(1);
    // Başlık yoksa istem başlık olur; panelde boş satır görünmemeli.
    expect(tasks[0]?.title).toBe("gerçek iş");
  });

  it("altı adımdan fazlasını kırpar", () => {
    const many = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, prompt: `p${i}` })),
    );
    expect(parsePlan(many)).toHaveLength(6);
  });

  it("bozuk çıktıda boş döner", () => {
    expect(parsePlan("plan yapamam")).toEqual([]);
    expect(parsePlan("[bu json değil")).toEqual([]);
    expect(parsePlan('{"title":"nesne","prompt":"dizi değil"}')).toEqual([]);
  });
});

describe("makePlan", () => {
  it("model bozuk çıktı verse bile tek adımlı plana düşer", async () => {
    const provider = scriptedProvider([text("bilmiyorum")]);
    const tasks = await makePlan(
      { provider, model: "test", signal: new AbortController().signal },
      "raporu hazırla",
    );
    // Planlama başarısız diye görev iptal olmamalı.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.prompt).toBe("raporu hazırla");
  });

  it("sağlayıcı patlarsa da tek adımlı plan verir", async () => {
    const provider: ChatProvider = {
      ...scriptedProvider([]),
      chat: () =>
        (async function* (): AsyncGenerator<ChatEvent> {
          throw new Error("motor kapalı");
        })(),
    };
    const tasks = await makePlan(
      { provider, model: "test", signal: new AbortController().signal },
      "raporu hazırla",
    );
    expect(tasks).toHaveLength(1);
  });
});

describe("runPlannedAgent", () => {
  it("adımları sırayla çalıştırır ve sonucu birleştirir", async () => {
    const provider = scriptedProvider([
      text('[{"title":"Topla","prompt":"veriyi topla"},{"title":"Yaz","prompt":"raporu yaz"}]'),
      text("veri toplandı"),
      text("rapor yazıldı"),
      text("Rapor hazır."),
    ]);

    const run = runPlannedAgent(options(provider));
    const events = await collect(run.events);
    const result = await run.result;

    expect(result.tasks.map((task) => task.title)).toEqual(["Topla", "Yaz"]);
    expect(result.finalText).toBe("Rapor hazır.");

    const kinds = events.map((event) => event.type);
    expect(kinds.filter((kind) => kind === "task_start")).toHaveLength(2);
    expect(kinds.filter((kind) => kind === "task_end")).toHaveLength(2);
    // Alt ajanın `done`'ı dışarı sızmamalı: plan henüz bitmedi.
    expect(kinds.filter((kind) => kind === "done")).toHaveLength(1);
    expect(kinds[0]).toBe("plan");
    expect(kinds.at(-1)).toBe("done");
  });

  it("her alt ajana yalnızca kendi adımını ve önceki özetleri verir", async () => {
    const provider = scriptedProvider([
      text('[{"title":"Bir","prompt":"birinci iş"},{"title":"İki","prompt":"ikinci iş"}]'),
      text("birincinin sonucu"),
      text("ikincinin sonucu"),
      text("bitti"),
    ]);

    await collect(runPlannedAgent(options(provider)).events);

    // seen[0] planlayıcı, seen[1] birinci alt ajan, seen[2] ikinci alt ajan.
    const first = provider.seen[1] ?? [];
    const second = provider.seen[2] ?? [];
    expect(first.at(-1)?.content).toBe("birinci iş");
    expect(second.at(-1)?.content).toBe("ikinci iş");

    const firstSystem = String(first[0]?.content ?? "");
    const secondSystem = String(second[0]?.content ?? "");
    // Sistem istemi ve bütün görev her adıma taşınır.
    expect(firstSystem).toContain("sistem istemi");
    expect(firstSystem).toContain("raporu hazırla");
    // Birinci adım henüz bir şey üretmediği için önceki sonuç yok.
    expect(firstSystem).not.toContain("Önceki adımların sonuçları");
    // İkinci adım birincinin çıktısını görür.
    expect(secondSystem).toContain("birincinin sonucu");
  });

  it("tek adımlık planda birleştirme üretimi yapmaz", async () => {
    const provider = scriptedProvider([
      text('[{"title":"Tek","prompt":"tek iş"}]'),
      text("tek işin sonucu"),
    ]);

    const run = runPlannedAgent(options(provider));
    await collect(run.events);
    const result = await run.result;

    expect(result.finalText).toBe("tek işin sonucu");
    // Planlayıcı + tek alt ajan = 2 çağrı; üçüncüsü israf olurdu.
    expect(provider.seen).toHaveLength(2);
  });

  it("ilk adımda durdurulursa sonrakini başlatmaz", async () => {
    // İptal gerçek hayatta bir aracın ortasında gelir. Kuyrukta geri basınç
    // olmadığı için dışarıdan zamanlamayla iptal etmek yarış üretirdi;
    // durdurmayı üretim akışının içinden tetikliyoruz.
    const controller = new AbortController();
    const stopper: Tool<Record<string, never>> = defineTool({
      name: "stopper",
      description: "Çalıştırmayı durdurur",
      risk: "read",
      schema: z.object({}),
      async run() {
        controller.abort();
        return { content: "durduruldu" };
      },
    });

    const provider = scriptedProvider([
      text('[{"title":"Bir","prompt":"bir"},{"title":"İki","prompt":"iki"}]'),
      [
        { type: "tool_call", call: { id: "c1", name: "stopper", arguments: "{}" } },
        { type: "done", finishReason: "tool_calls" },
      ],
    ]);

    const run = runPlannedAgent({
      ...options(provider),
      tools: [stopper as Tool<never>],
      signal: controller.signal,
    });
    const events = await collect(run.events);
    await run.result;

    expect(events.filter((event) => event.type === "task_start")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
  });

  it("bir adım metin üretmezse başarısız işaretlenir ama plan sürer", async () => {
    const provider = scriptedProvider([
      text('[{"title":"Bir","prompt":"bir"},{"title":"İki","prompt":"iki"}]'),
      [{ type: "done", finishReason: "stop" }],
      text("ikinci oldu"),
      text("özet"),
    ]);

    const events = await collect(runPlannedAgent(options(provider)).events);
    const ends = events.filter((event) => event.type === "task_end");
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ failed: true });
    expect(ends[1]).toMatchObject({ failed: false });
  });
});
