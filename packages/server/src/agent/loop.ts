import type {
  ChatMessage,
  ChatProvider,
  ToolCall,
} from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import type { ApprovalGate } from "./approval.js";
import { EventQueue } from "./queue.js";
import { findTool, toProviderTools } from "./registry.js";
import type { AgentEvent, Tool, ToolResult } from "./types.js";

/**
 * Ajan döngüsü.
 *
 * Sağlayıcıdan bağımsızdır: yerel llama.cpp da OpenAI de aynı
 * `ChatProvider` arayüzünü sunar, döngü hangisi olduğunu bilmez.
 *
 * Akış: model çağrılır → araç isteği varsa yürütülür (gerekirse onay
 * beklenir) → sonuç konuşmaya eklenir → model yeniden çağrılır. Araç
 * isteği kalmayınca ya da adım sınırına gelince biter.
 */

export interface AgentRunOptions {
  provider: ChatProvider;
  model: string;
  messages: ChatMessage[];
  tools: Tool<never>[];
  workspaceRoot: string;
  gate: ApprovalGate;
  signal: AbortSignal;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
}

export interface AgentRunResult {
  /** Döngü sonundaki tam konuşma; çağıran taraf kalıcılaştırır. */
  messages: ChatMessage[];
  finalText: string;
}

const DEFAULT_MAX_STEPS = 12;

export function runAgent(
  options: AgentRunOptions,
): { events: AsyncGenerator<AgentEvent>; result: Promise<AgentRunResult> } {
  const queue = new EventQueue<AgentEvent>();
  const result = execute(options, queue).finally(() => queue.close());
  // Tüketici hatayı olay akışında görür; burada sessize alıyoruz ki
  // yakalanmamış reddetme oluşmasın.
  result.catch(() => undefined);
  return { events: queue.drain(), result };
}

async function execute(
  options: AgentRunOptions,
  queue: EventQueue<AgentEvent>,
): Promise<AgentRunResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages = [...options.messages];
  const providerTools = toProviderTools(options.tools);
  let finalText = "";

  for (let step = 0; step < maxSteps; step += 1) {
    if (options.signal.aborted) {
      queue.push({ type: "done", reason: "aborted" });
      return { messages, finalText };
    }
    queue.push({ type: "step", index: step });

    let text = "";
    const calls: ToolCall[] = [];

    try {
      for await (const event of options.provider.chat(
        messages,
        {
          model: options.model,
          signal: options.signal,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        },
        providerTools,
      )) {
        switch (event.type) {
          case "text":
            text += event.delta;
            queue.push({ type: "text", delta: event.delta });
            break;
          case "reasoning":
            queue.push({ type: "reasoning", delta: event.delta });
            break;
          case "tool_call":
            calls.push(event.call);
            break;
          case "usage":
            queue.push({
              type: "usage",
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
            });
            break;
          case "error":
            queue.push({ type: "error", message: event.message });
            break;
          case "done":
            break;
        }
      }
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? err.message
          : `Sağlayıcı hatası: ${(err as Error).message}`;
      queue.push({ type: "error", message });
      queue.push({ type: "done", reason: "error" });
      return { messages, finalText };
    }

    if (text) finalText = text;

    if (calls.length === 0) {
      messages.push({ role: "assistant", content: text });
      queue.push({ type: "done", reason: "stop" });
      return { messages, finalText };
    }

    messages.push({ role: "assistant", content: text, toolCalls: calls });

    for (const call of calls) {
      if (options.signal.aborted) break;
      const outcome = await runTool(call, options, queue);
      messages.push({
        role: "tool",
        content: outcome.content,
        toolCallId: call.id,
        name: call.name,
      });
    }
  }

  queue.push({ type: "done", reason: "max_steps" });
  return { messages, finalText };
}

async function runTool(
  call: ToolCall,
  options: AgentRunOptions,
  queue: EventQueue<AgentEvent>,
): Promise<ToolResult> {
  const started = Date.now();
  const tool = findTool(options.tools, call.name);

  const finish = (result: ToolResult): ToolResult => {
    queue.push({
      type: "tool_end",
      id: call.id,
      name: call.name,
      result,
      ms: Date.now() - started,
    });
    return result;
  };

  if (!tool) {
    queue.push({ type: "tool_start", id: call.id, name: call.name, arguments: {} });
    return finish({ content: `Bilinmeyen araç: ${call.name}`, isError: true });
  }

  // Model bozuk JSON üretebilir; bu bir hata mesajıdır, çökme değil.
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(call.arguments || "{}");
  } catch {
    queue.push({ type: "tool_start", id: call.id, name: call.name, arguments: {} });
    return finish({
      content: `Araç argümanları geçerli JSON değil: ${call.arguments.slice(0, 200)}`,
      isError: true,
    });
  }

  queue.push({
    type: "tool_start",
    id: call.id,
    name: call.name,
    arguments: parsedArguments,
  });

  const validated = tool.schema.safeParse(parsedArguments);
  if (!validated.success) {
    return finish({
      content:
        `Araç argümanları şemaya uymuyor:\n` +
        validated.error.issues
          .map((issue) => `- ${issue.path.join(".") || "(kök)"}: ${issue.message}`)
          .join("\n"),
      isError: true,
    });
  }

  try {
    const result = await tool.run(validated.data as never, {
      workspaceRoot: options.workspaceRoot,
      signal: options.signal,
      requestApproval: async (request) => {
        if (!options.gate.needsApproval(tool.risk, tool.name)) return true;
        // Kimliği kapı üretir; istemci onunla cevap verecek, bu yüzden
        // çözüm olayında da aynısı kullanılmalı.
        let approvalId = "";
        const approved = await options.gate.request(request, (pending) => {
          approvalId = pending.id;
          queue.push({
            type: "approval_request",
            id: pending.id,
            request: pending.request,
          });
        });
        queue.push({ type: "approval_resolved", id: approvalId, approved });
        return approved;
      },
    });
    return finish(result);
  } catch (err) {
    return finish({
      content: `Araç hata verdi: ${(err as Error).message}`,
      isError: true,
    });
  }
}
