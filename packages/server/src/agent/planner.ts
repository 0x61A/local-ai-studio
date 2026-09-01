import crypto from "node:crypto";
import type { ChatMessage, ContentPart } from "../providers/types.js";
import { runAgent, type AgentRunOptions, type AgentRunResult } from "./loop.js";
import { EventQueue } from "./queue.js";
import type { AgentEvent, PlanTask } from "./types.js";

/**
 * Çok ajanlı planlayıcı.
 *
 * Tek bir uzun döngü yerine: görev alt görevlere ayrılır, her biri kendi
 * bağlamıyla ayrı bir alt ajan olarak çalıştırılır, sonuçlar birleştirilir.
 * Kazanç bağlam hijyeni -- otuz araç çağrısını tek pencereye yığmak yerine
 * her alt ajan yalnızca kendi işini ve önceki adımların özetini görür.
 *
 * Alt ajanlar `runAgent`'ın kendisidir; onay kapısı, sandbox ve araç kaydı
 * olduğu gibi devralınır. Planlayıcı yalnızca sırayı ve bağlamı kurar.
 *
 * Sıralı çalışırlar. Paralel çalıştırmak yerel tek motor yuvasında zaten
 * kuyruğa girerdi ve aynı anda iki onay kartı sormak kararı veren insan
 * için anlaşılmaz olurdu.
 */

const MAX_TASKS = 6;
/** Bir alt görevin özeti sonrakilere bu uzunlukta taşınır. */
const SUMMARY_CHARS = 1200;

const PLANNER_PROMPT = [
  "Sen bir görev planlayıcısısın. Verilen görevi sırayla yürütülecek",
  "alt görevlere böl. Her alt görev tek başına anlaşılır olmalı ve bir",
  "önceki adımın çıktısına dayanabilir.",
  "",
  `En fazla ${MAX_TASKS} adım üret. Görev tek adımlıksa tek adım üret --`,
  "yapay şekilde bölme.",
  "",
  "YALNIZCA şu biçimde JSON dizisi döndür, başka hiçbir şey yazma:",
  '[{"title": "kısa başlık", "prompt": "alt ajana verilecek tam talimat"}]',
].join("\n");

export interface PlannedRunResult extends AgentRunResult {
  tasks: PlanTask[];
}

export function runPlannedAgent(options: AgentRunOptions): {
  events: AsyncGenerator<AgentEvent>;
  result: Promise<PlannedRunResult>;
} {
  const queue = new EventQueue<AgentEvent>();
  const result = executePlan(options, queue).finally(() => queue.close());
  result.catch(() => undefined);
  return { events: queue.drain(), result };
}

async function executePlan(
  options: AgentRunOptions,
  queue: EventQueue<AgentEvent>,
): Promise<PlannedRunResult> {
  const goal = lastUserMessage(options.messages);
  const systemPrompt = asText(options.messages.find((m) => m.role === "system")?.content);

  const tasks = await makePlan(options, goal);
  queue.push({ type: "plan", tasks });

  const outcomes: Array<{ task: PlanTask; summary: string; failed: boolean }> = [];

  for (const [index, task] of tasks.entries()) {
    if (options.signal.aborted) {
      queue.push({ type: "done", reason: "aborted" });
      return { messages: options.messages, finalText: mergeFallback(outcomes), tasks };
    }

    queue.push({ type: "task_start", id: task.id, index, title: task.title });
    const started = Date.now();

    const sub = runAgent({
      ...options,
      messages: buildTaskMessages(systemPrompt, goal, task, outcomes),
    });

    for await (const event of sub.events) {
      // Alt ajanın bitişi planın bitişi değil; kendi `done`umuzu sonda atarız.
      if (event.type === "done") continue;
      queue.push(event);
    }

    const finished = await sub.result;
    const summary = finished.finalText.trim();
    const failed = summary.length === 0;
    outcomes.push({ task, summary, failed });
    queue.push({
      type: "task_end",
      id: task.id,
      failed,
      summary: summary.slice(0, SUMMARY_CHARS),
      ms: Date.now() - started,
    });
  }

  const finalText = await merge(options, queue, goal, outcomes);
  queue.push({ type: "done", reason: "stop" });
  return { messages: options.messages, finalText, tasks };
}

/**
 * Planı modele yazdırır. Model bozuk çıktı verirse tek adımlı plana düşer:
 * planlama başarısız diye görevin kendisi başarısız olmamalı.
 */
export async function makePlan(
  options: Pick<AgentRunOptions, "provider" | "model" | "signal">,
  goal: string,
): Promise<PlanTask[]> {
  let text = "";
  try {
    for await (const event of options.provider.chat(
      [
        { role: "system", content: PLANNER_PROMPT },
        { role: "user", content: goal },
      ],
      { model: options.model, signal: options.signal, temperature: 0 },
    )) {
      if (event.type === "text") text += event.delta;
    }
  } catch {
    return [singleTask(goal)];
  }

  const parsed = parsePlan(text);
  return parsed.length > 0 ? parsed : [singleTask(goal)];
}

/**
 * Plan JSON'unu metnin içinden çıkarır. Modeller diziyi açıklama cümlesiyle
 * ya da ``` çitiyle sarmalar; ilk `[` ile son `]` arası aranır.
 */
export function parsePlan(text: string): PlanTask[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const tasks: PlanTask[] = [];
  for (const entry of raw) {
    if (tasks.length >= MAX_TASKS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const prompt = typeof record["prompt"] === "string" ? record["prompt"].trim() : "";
    if (!prompt) continue;
    const title = typeof record["title"] === "string" ? record["title"].trim() : "";
    tasks.push({
      id: crypto.randomUUID(),
      title: (title || prompt).slice(0, 120),
      prompt,
    });
  }
  return tasks;
}

function buildTaskMessages(
  systemPrompt: string,
  goal: string,
  task: PlanTask,
  outcomes: Array<{ task: PlanTask; summary: string; failed: boolean }>,
): ChatMessage[] {
  const context = outcomes
    .map(
      (outcome, index) =>
        `${index + 1}. ${outcome.task.title}\n${
          outcome.failed ? "(sonuç üretilmedi)" : outcome.summary.slice(0, SUMMARY_CHARS)
        }`,
    )
    .join("\n\n");

  const parts = [
    systemPrompt,
    `Bütün görev: ${goal}`,
    "Sen bu görevin bir adımını yürüten alt ajansın. Yalnızca kendi adımını",
    "yap, sonrakileri yapma. Bitirdiğinde ne bulduğunu/ne yaptığını sonraki",
    "adımın kullanabileceği somut bir özetle yaz.",
  ];
  if (context) parts.push(`Önceki adımların sonuçları:\n\n${context}`);

  return [
    { role: "system", content: parts.filter(Boolean).join("\n\n") },
    { role: "user", content: task.prompt },
  ];
}

/** Adım özetlerini tek cevaba dönüştürür; metni akışa da yazar. */
async function merge(
  options: AgentRunOptions,
  queue: EventQueue<AgentEvent>,
  goal: string,
  outcomes: Array<{ task: PlanTask; summary: string; failed: boolean }>,
): Promise<string> {
  if (outcomes.length === 0) return "";
  // Tek adımlık planda birleştirecek bir şey yok; ikinci üretim israf olurdu.
  if (outcomes.length === 1) return outcomes[0]?.summary ?? "";

  const body = outcomes
    .map(
      (outcome, index) =>
        `Adım ${index + 1} -- ${outcome.task.title}\n${
          outcome.failed ? "(sonuç üretilmedi)" : outcome.summary
        }`,
    )
    .join("\n\n");

  let text = "";
  try {
    for await (const event of options.provider.chat(
      [
        {
          role: "system",
          content:
            "Adım sonuçlarını kullanıcıya tek bir cevap hâlinde birleştir. " +
            "Adım adım anlatma; sonucu söyle. Bir adım başarısızsa bunu belirt.",
        },
        { role: "user", content: `Görev: ${goal}\n\n${body}` },
      ],
      { model: options.model, signal: options.signal },
    )) {
      if (event.type === "text") {
        text += event.delta;
        queue.push({ type: "text", delta: event.delta });
      }
    }
  } catch {
    return mergeFallback(outcomes);
  }
  return text.trim() || mergeFallback(outcomes);
}

/** Birleştirme üretimi başarısızsa özetleri olduğu gibi ver. */
function mergeFallback(
  outcomes: Array<{ task: PlanTask; summary: string; failed: boolean }>,
): string {
  return outcomes
    .filter((outcome) => !outcome.failed)
    .map((outcome) => `**${outcome.task.title}**\n${outcome.summary}`)
    .join("\n\n");
}

function singleTask(goal: string): PlanTask {
  return { id: crypto.randomUUID(), title: goal.slice(0, 120), prompt: goal };
}

function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return asText(messages[i]?.content);
  }
  return "";
}

/** Görsel içeren mesajlar parça dizisi taşır; planlayıcıya metin lazım. */
function asText(content: string | ContentPart[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part.text ?? "").join(" ").trim();
}
