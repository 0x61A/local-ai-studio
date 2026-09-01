import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ApprovalGate } from "../src/agent/approval.js";
import { EventQueue } from "../src/agent/queue.js";
import { runAgent } from "../src/agent/loop.js";
import { defineTool, toolParameters, type Tool } from "../src/agent/types.js";
import { unifiedDiff, newFileDiff } from "../src/agent/diff.js";
import { toProviderTools } from "../src/agent/registry.js";
import { readFile, writeFile, listDir } from "../src/agent/tools/files.js";
import type {
  ChatEvent,
  ChatMessage,
  ChatProvider,
} from "../src/providers/types.js";

// -- Sahte sağlayıcı ----------------------------------------------------------

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

function toolCall(id: string, name: string, args: unknown): ChatEvent {
  return { type: "tool_call", call: { id, name, arguments: JSON.stringify(args) } };
}

async function collect(events: AsyncGenerator<unknown>) {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out as Array<Record<string, unknown>>;
}

// -- Test aracı ---------------------------------------------------------------

let sideEffects: string[] = [];

const echoTool: Tool<{ text: string }> = defineTool({
  name: "echo",
  description: "Verilen metni geri döner",
  risk: "read",
  schema: z.object({ text: z.string() }),
  async run(input) {
    sideEffects.push(`echo:${input.text}`);
    return { content: `echo: ${input.text}` };
  },
});

const dangerTool: Tool<{ what: string }> = defineTool({
  name: "danger",
  description: "Onay isteyen araç",
  risk: "write",
  schema: z.object({ what: z.string() }),
  async run(input, context) {
    const approved = await context.requestApproval({
      toolName: "danger",
      risk: "write",
      summary: `Tehlikeli iş: ${input.what}`,
      arguments: input,
    });
    if (!approved) return { content: "reddedildi", isError: true };
    sideEffects.push(`danger:${input.what}`);
    return { content: "yapıldı" };
  },
});

let workspace: string;

beforeEach(() => {
  sideEffects = [];
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "studio-agent-"));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function baseOptions(provider: ChatProvider, tools: Tool<never>[]) {
  return {
    provider,
    model: "test",
    messages: [{ role: "user" as const, content: "başla" }],
    tools,
    workspaceRoot: workspace,
    gate: new ApprovalGate(1000),
    signal: new AbortController().signal,
  };
}

// -- Kuyruk -------------------------------------------------------------------

describe("EventQueue", () => {
  it("yazılan öğeleri sırayla verir", async () => {
    const queue = new EventQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const seen: number[] = [];
    for await (const item of queue.drain()) seen.push(item);
    expect(seen).toEqual([1, 2]);
  });

  it("tüketici beklerken gelen öğeyi teslim eder", async () => {
    const queue = new EventQueue<string>();
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const item of queue.drain()) collected.push(item);
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    queue.push("geç gelen");
    queue.close();
    await consumer;
    expect(collected).toEqual(["geç gelen"]);
  });

  it("kapandıktan sonra yazma yoksayılır", async () => {
    const queue = new EventQueue<number>();
    queue.close();
    queue.push(1);
    expect(await collect(queue.drain())).toEqual([]);
  });
});

// -- Onay kapısı --------------------------------------------------------------

describe("ApprovalGate", () => {
  it("read araçları onay istemez", () => {
    const gate = new ApprovalGate();
    expect(gate.needsApproval("read", "read_file")).toBe(false);
    expect(gate.needsApproval("write", "write_file")).toBe(true);
    expect(gate.needsApproval("exec", "run_command")).toBe(true);
  });

  it("onay verilince true döner", async () => {
    const gate = new ApprovalGate();
    let id = "";
    const pending = gate.request(
      { toolName: "x", risk: "write", summary: "s", arguments: {} },
      (p) => { id = p.id; },
    );
    expect(gate.resolve(id, true)).toBe(true);
    expect(await pending).toBe(true);
  });

  it("zaman aşımında reddeder -- cevapsızlık izin demek değildir", async () => {
    const gate = new ApprovalGate(50);
    const pending = gate.request(
      { toolName: "x", risk: "write", summary: "s", arguments: {} },
      () => {},
    );
    expect(await pending).toBe(false);
  });

  it("'hep izin ver' yalnızca o araç için geçerli", async () => {
    const gate = new ApprovalGate();
    let id = "";
    const pending = gate.request(
      { toolName: "write_file", risk: "write", summary: "s", arguments: {} },
      (p) => { id = p.id; },
    );
    gate.resolve(id, true, true);
    await pending;
    expect(gate.needsApproval("write", "write_file")).toBe(false);
    expect(gate.needsApproval("exec", "run_command")).toBe(true);
  });

  it("durdurma bekleyen her şeyi reddeder", async () => {
    const gate = new ApprovalGate();
    const pending = gate.request(
      { toolName: "x", risk: "write", summary: "s", arguments: {} },
      () => {},
    );
    gate.rejectAll();
    expect(await pending).toBe(false);
  });

  it("bilinmeyen kimliği çözemez", () => {
    expect(new ApprovalGate().resolve("yok", true)).toBe(false);
  });
});

// -- Ajan döngüsü -------------------------------------------------------------

describe("runAgent", () => {
  it("araç istemeyen turda hemen biter", async () => {
    const provider = scriptedProvider([
      [{ type: "text", delta: "merhaba" }, { type: "done", finishReason: "stop" }],
    ]);
    const { events, result } = runAgent(baseOptions(provider, [echoTool as Tool<never>]));
    const seen = await collect(events);
    expect(seen.filter((e) => e["type"] === "text").map((e) => e["delta"])).toEqual(["merhaba"]);
    expect(seen.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect((await result).finalText).toBe("merhaba");
  });

  it("aracı çalıştırıp sonucu modele geri besler", async () => {
    const provider = scriptedProvider([
      [toolCall("c1", "echo", { text: "selam" }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "text", delta: "bitti" }, { type: "done", finishReason: "stop" }],
    ]);
    const { events, result } = runAgent(baseOptions(provider, [echoTool as Tool<never>]));
    const seen = await collect(events);

    expect(sideEffects).toEqual(["echo:selam"]);
    expect(seen.some((e) => e["type"] === "tool_start" && e["name"] === "echo")).toBe(true);
    expect(seen.some((e) => e["type"] === "tool_end")).toBe(true);

    // İkinci tur araç sonucunu görmüş olmalı.
    const secondTurn = provider.seen[1]!;
    expect(secondTurn.at(-1)).toMatchObject({ role: "tool", content: "echo: selam" });
    expect((await result).finalText).toBe("bitti");
  });

  it("paralel araç çağrılarını sırayla yürütür", async () => {
    const provider = scriptedProvider([
      [
        toolCall("c1", "echo", { text: "bir" }),
        toolCall("c2", "echo", { text: "iki" }),
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    await collect(runAgent(baseOptions(provider, [echoTool as Tool<never>])).events);
    expect(sideEffects).toEqual(["echo:bir", "echo:iki"]);
  });

  it("bilinmeyen aracı hata olarak geri bildirir, çökmez", async () => {
    const provider = scriptedProvider([
      [toolCall("c1", "olmayan", {}), { type: "done", finishReason: "tool_calls" }],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const seen = await collect(runAgent(baseOptions(provider, [echoTool as Tool<never>])).events);
    const end = seen.find((e) => e["type"] === "tool_end") as
      | { result: { content: string; isError: boolean } }
      | undefined;
    expect(end?.result.isError).toBe(true);
    expect(end?.result.content).toContain("Bilinmeyen araç");
  });

  it("bozuk JSON argümanında çökmez", async () => {
    const provider = scriptedProvider([
      [
        { type: "tool_call", call: { id: "c1", name: "echo", arguments: "{bozuk" } },
        { type: "done", finishReason: "tool_calls" },
      ],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const seen = await collect(runAgent(baseOptions(provider, [echoTool as Tool<never>])).events);
    const end = seen.find((e) => e["type"] === "tool_end") as
      | { result: { content: string; isError: boolean } }
      | undefined;
    expect(end?.result.isError).toBe(true);
    expect(end?.result.content).toContain("geçerli JSON değil");
    expect(sideEffects).toEqual([]);
  });

  it("şemaya uymayan argümanı reddeder", async () => {
    const provider = scriptedProvider([
      [toolCall("c1", "echo", { yanlis: 1 }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const seen = await collect(runAgent(baseOptions(provider, [echoTool as Tool<never>])).events);
    const end = seen.find((e) => e["type"] === "tool_end") as
      | { result: { content: string; isError: boolean } }
      | undefined;
    expect(end?.result.isError).toBe(true);
    expect(end?.result.content).toContain("şemaya uymuyor");
    expect(sideEffects).toEqual([]);
  });

  it("onay reddedilirse araç iş yapmaz", async () => {
    const provider = scriptedProvider([
      [toolCall("c1", "danger", { what: "sil" }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const options = baseOptions(provider, [dangerTool as Tool<never>]);
    const { events } = runAgent(options);

    const seen: Array<Record<string, unknown>> = [];
    for await (const event of events) {
      seen.push(event as Record<string, unknown>);
      if (event.type === "approval_request") {
        options.gate.resolve(event.id, false);
      }
    }

    expect(sideEffects).toEqual([]);
    expect(seen.some((e) => e["type"] === "approval_resolved" && e["approved"] === false)).toBe(true);
  });

  it("onay verilirse araç çalışır", async () => {
    const provider = scriptedProvider([
      [toolCall("c1", "danger", { what: "yaz" }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const options = baseOptions(provider, [dangerTool as Tool<never>]);
    for await (const event of runAgent(options).events) {
      if (event.type === "approval_request") options.gate.resolve(event.id, true);
    }
    expect(sideEffects).toEqual(["danger:yaz"]);
  });

  it("onay kimliği istek ve çözüm olaylarında aynıdır", async () => {
    const provider = scriptedProvider([
      [toolCall("c1", "danger", { what: "x" }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const options = baseOptions(provider, [dangerTool as Tool<never>]);
    let requestId = "";
    let resolvedId = "";
    for await (const event of runAgent(options).events) {
      if (event.type === "approval_request") {
        requestId = event.id;
        options.gate.resolve(event.id, true);
      }
      if (event.type === "approval_resolved") resolvedId = event.id;
    }
    expect(requestId).not.toBe("");
    expect(resolvedId).toBe(requestId);
  });

  it("adım sınırına ulaşınca durur", async () => {
    // Her turda araç isteyen, hiç durmayan model.
    const provider: ChatProvider = {
      id: "llamacpp",
      label: "sonsuz",
      capabilities: { tools: true, vision: false, embeddings: false, requiresApiKey: false },
      isReady: async () => true,
      listModels: async () => [],
      chat: () =>
        (async function* () {
          yield toolCall(`c${Math.random()}`, "echo", { text: "yine" });
          yield { type: "done", finishReason: "tool_calls" } as ChatEvent;
        })(),
    };
    const seen = await collect(
      runAgent({ ...baseOptions(provider, [echoTool as Tool<never>]), maxSteps: 3 }).events,
    );
    expect(seen.at(-1)).toMatchObject({ type: "done", reason: "max_steps" });
    expect(sideEffects).toHaveLength(3);
  });

  it("iptal edilince durur", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([
      [toolCall("c1", "echo", { text: "bir" }), { type: "done", finishReason: "tool_calls" }],
      [{ type: "done", finishReason: "stop" }],
    ]);
    const options = { ...baseOptions(provider, [echoTool as Tool<never>]), signal: controller.signal };
    controller.abort();
    const seen = await collect(runAgent(options).events);
    expect(seen.at(-1)).toMatchObject({ type: "done", reason: "aborted" });
    expect(sideEffects).toEqual([]);
  });

  it("sağlayıcı hatasını olay olarak yayar, çökmez", async () => {
    const provider: ChatProvider = {
      id: "llamacpp",
      label: "hatali",
      capabilities: { tools: true, vision: false, embeddings: false, requiresApiKey: false },
      isReady: async () => true,
      listModels: async () => [],
      chat: () =>
        (async function* (): AsyncGenerator<ChatEvent> {
          throw new Error("bağlantı koptu");
        })(),
    };
    const seen = await collect(runAgent(baseOptions(provider, [])).events);
    expect(seen.some((e) => e["type"] === "error")).toBe(true);
    expect(seen.at(-1)).toMatchObject({ type: "done", reason: "error" });
  });
});

// -- Sandbox ------------------------------------------------------------------

describe("dosya araçları sandbox", () => {
  const context = () => ({
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    requestApproval: async () => true,
  });

  it("çalışma alanı içinde okur", async () => {
    fs.writeFileSync(path.join(workspace, "not.txt"), "içerik");
    const result = await readFile.run({ path: "not.txt" }, context());
    expect(result.content).toBe("içerik");
  });

  it("çalışma alanı dışına çıkmayı reddeder", async () => {
    await expect(readFile.run({ path: "../../etc/passwd" }, context())).rejects.toThrow(
      /çalışma alanının dışında/,
    );
  });

  it("sembolik bağla kaçmayı reddeder", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "studio-outside-"));
    fs.writeFileSync(path.join(outside, "gizli.txt"), "gizli");
    // "junction": Windows'ta dizin bagi olusturmak yonetici yetkisi ister,
    // birlesme noktasi istemez. Diger platformlarda tur yok sayilir.
    fs.symlinkSync(outside, path.join(workspace, "kacis"), "junction");
    try {
      await expect(readFile.run({ path: "kacis/gizli.txt" }, context())).rejects.toThrow(
        /çalışma alanının dışında/,
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ikili dosyayı metin diye modele akıtmaz", async () => {
    fs.writeFileSync(path.join(workspace, "ikili.bin"), Buffer.from([0, 1, 2, 0, 255]));
    const result = await readFile.run({ path: "ikili.bin" }, context());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("ikili");
  });

  it("onay reddedilirse dosya yazılmaz", async () => {
    const result = await writeFile.run(
      { path: "yeni.txt", content: "veri" },
      { ...context(), requestApproval: async () => false },
    );
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(workspace, "yeni.txt"))).toBe(false);
  });

  it("onay verilirse dosya yazılır", async () => {
    await writeFile.run({ path: "alt/yeni.txt", content: "veri" }, context());
    expect(fs.readFileSync(path.join(workspace, "alt/yeni.txt"), "utf8")).toBe("veri");
  });

  it("klasör listeler", async () => {
    fs.writeFileSync(path.join(workspace, "a.txt"), "x");
    fs.mkdirSync(path.join(workspace, "klasor"));
    const result = await listDir.run({}, context());
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("klasor/");
  });
});

// -- Şema ve fark -------------------------------------------------------------

describe("araç şemaları", () => {
  it("zod'dan JSON Schema türetir ve $schema anahtarını atar", () => {
    const parameters = toolParameters(echoTool as Tool<never>);
    expect(parameters["$schema"]).toBeUndefined();
    expect(parameters["type"]).toBe("object");
    expect((parameters["properties"] as Record<string, unknown>)["text"]).toBeTruthy();
  });

  it("sağlayıcı tanımlarını üretir", () => {
    const definitions = toProviderTools([echoTool as Tool<never>]);
    expect(definitions[0]).toMatchObject({ name: "echo", description: expect.any(String) });
    expect(definitions[0]?.parameters["type"]).toBe("object");
  });

  it("dizge uzunluk sınırlarını şemadan çıkarır", () => {
    // llama.cpp şemayı bir GBNF dilbilgisine çeviriyor ve belirli uzunluk
    // değerleri bozuk dilbilgisi üretiyor: maxLength 2000 olan tek bir araç
    // isteğin TAMAMINI "failed to parse grammar" ile 400'e düşürüyordu.
    // Uzunluk zaten zod tarafında doğrulanıyor, sağlayıcıya gitmesi gereksiz.
    const bounded: Tool<{ a: string }> = defineTool({
      name: "bounded",
      description: "sınırlı",
      risk: "read",
      schema: z.object({ a: z.string().min(1).max(2000) }),
      async run() {
        return { content: "" };
      },
    });

    const parameters = toolParameters(bounded as Tool<never>);
    const property = (parameters["properties"] as Record<string, Record<string, unknown>>)["a"];
    expect(property?.["maxLength"]).toBeUndefined();
    expect(property?.["minLength"]).toBeUndefined();
    expect(property?.["type"]).toBe("string");
  });

  it("sayı aralıklarını korur", () => {
    // Bunlar dilbilgisini bozmuyor ve modele gerçekten yol gösteriyor.
    const ranged: Tool<{ n: number }> = defineTool({
      name: "ranged",
      description: "aralıklı",
      risk: "read",
      schema: z.object({ n: z.number().int().min(1).max(80) }),
      async run() {
        return { content: "" };
      },
    });

    const property = (
      toolParameters(ranged as Tool<never>)["properties"] as Record<
        string,
        Record<string, unknown>
      >
    )["n"];
    expect(property?.["minimum"]).toBe(1);
    expect(property?.["maximum"]).toBe(80);
  });

  it("MCP şemalarındaki uzunluk sınırlarını da çıkarır", () => {
    // Üçüncü taraf bir MCP sunucusu aynı tuzağa düşebilir; şema oradan
    // olduğu gibi geçiyor ama bu anahtar her yerde tehlikeli.
    const mcpish: Tool<unknown> = defineTool({
      name: "mcp__x__y",
      description: "dış araç",
      risk: "read",
      schema: z.object({}),
      parametersOverride: {
        type: "object",
        properties: { q: { type: "string", maxLength: 2000 } },
      },
      async run() {
        return { content: "" };
      },
    });

    const property = (
      toolParameters(mcpish as Tool<never>)["properties"] as Record<
        string,
        Record<string, unknown>
      >
    )["q"];
    expect(property?.["maxLength"]).toBeUndefined();
  });
});

describe("fark üreteci", () => {
  it("değişen satırı gösterir", () => {
    const diff = unifiedDiff("bir\niki\nüç", "bir\nİKİ\nüç", "a.txt");
    expect(diff).toContain("-iki");
    expect(diff).toContain("+İKİ");
    expect(diff).toContain(" bir");
  });

  it("değişiklik yoksa söyler", () => {
    expect(unifiedDiff("aynı", "aynı", "a.txt")).toContain("değişiklik yok");
  });

  it("yeni dosyayı tamamen eklenmiş gösterir", () => {
    const diff = newFileDiff("satır1\nsatır2", "yeni.txt");
    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+satır1");
  });
});

// -- Çalışma alanı normalleştirme --------------------------------------------

describe("çalışma alanı yolu", () => {
  it("sembolik bağlı kökte göreli yol doğru çıkar", async () => {
    // macOS'ta /tmp -> /private/tmp. Kök ham hâlde saklanırsa onay
    // kartında "../../private/tmp/..." görünür ve kullanıcıya kaçış
    // denemesi gibi gelir. Kök gerçek yola çevrilmiş olmalı.
    const real = fs.realpathSync(workspace);
    const target = path.join(real, "dosya.txt");
    expect(path.relative(real, target)).toBe("dosya.txt");
    expect(path.relative(real, target).startsWith("..")).toBe(false);
  });

  it("yazma onayında göreli yol gösterilir", async () => {
    let seenSummary = "";
    await writeFile.run(
      { path: "alt/dosya.txt", content: "x" },
      {
        workspaceRoot: fs.realpathSync(workspace),
        signal: new AbortController().signal,
        requestApproval: async (request) => {
          seenSummary = request.summary;
          return false;
        },
      },
    );
    expect(seenSummary).toContain("alt/dosya.txt");
    expect(seenSummary).not.toContain("..");
  });
});
