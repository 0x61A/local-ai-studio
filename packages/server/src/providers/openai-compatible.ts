import { readSseStream } from "./sse.js";
import {
  ProviderError,
  isRetriableStatus,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type ContentPart,
  type ToolCall,
  type ToolDefinition,
} from "./types.js";

/**
 * OpenAI uyumlu `/v1/chat/completions` istemcisi.
 *
 * llama.cpp'nin llama-server'ı, OpenAI ve OpenRouter aynı teli konuşur;
 * üçü de bu tek uygulamayı kullanır. Anthropic ve Gemini kendi
 * adaptörlerine sahiptir.
 */

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  /** Sağlayıcıya özgü ek başlıklar (ör. OpenRouter atıf başlıkları). */
  headers?: Record<string, string>;
}

export async function* streamOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  tools?: ToolDefinition[],
): AsyncGenerator<ChatEvent> {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: messages.map(toWireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  if (options.topP !== undefined) body["top_p"] = options.topP;
  if (options.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;
  if (options.stop?.length) body["stop"] = options.stop;
  if (options.seed !== undefined) body["seed"] = options.seed;
  if (tools?.length) {
    body["tools"] = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      ...config.headers,
    },
    body: JSON.stringify(body),
    signal: options.signal ?? null,
  });

  if (!response.ok || !response.body) {
    throw await describeHttpFailure(response);
  }

  const calls = new ToolCallAccumulator();
  let finishReason = "stop";
  let sawToolCall = false;

  for await (const event of readSseStream(response.body, options.signal)) {
    if (event.data === "[DONE]") break;

    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(event.data) as OpenAiChunk;
    } catch {
      continue; // yarım/bozuk parça: bir sonraki olayla düzelir
    }

    if (chunk.error) {
      throw new ProviderError(chunk.error.message ?? "Sağlayıcı hatası", false);
    }

    if (chunk.usage) {
      yield {
        type: "usage",
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta;
    if (delta?.content) yield { type: "text", delta: delta.content };

    // Düşünme/akıl yürütme alanının adı sağlayıcıya göre değişiyor.
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) yield { type: "reasoning", delta: reasoning };

    if (delta?.tool_calls?.length) {
      sawToolCall = true;
      calls.absorb(delta.tool_calls);
    }

    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  for (const call of calls.drain()) {
    yield { type: "tool_call", call };
  }

  yield {
    type: "done",
    finishReason: normalizeFinishReason(finishReason, sawToolCall),
  };
}

// -- Araç çağrısı biriktirme --------------------------------------------------

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/**
 * Akışta araç çağrıları parça parça gelir: önce `id` ve `name`, sonra
 * `arguments` birkaç parçaya bölünmüş hâlde. Aynı çağrının parçaları
 * `index` ile eşleşir. Bunları birleştirmeden JSON.parse etmek bozuk
 * argüman üretir -- bu yüzden biriktirici ayrı bir birim.
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<
    number,
    { id: string; name: string; args: string }
  >();

  absorb(deltas: WireToolCallDelta[]): void {
    for (const delta of deltas) {
      const index = delta.index ?? 0;
      const current = this.byIndex.get(index) ?? { id: "", name: "", args: "" };
      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.name += delta.function.name;
      if (delta.function?.arguments) current.args += delta.function.arguments;
      this.byIndex.set(index, current);
    }
  }

  /** Tamamlanmış çağrıları index sırasına göre verir ve tamponu boşaltır. */
  drain(): ToolCall[] {
    const out = [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, call]) => call.name)
      .map(([index, call]) => ({
        // Bazı yerel motorlar id göndermiyor; deterministik bir tane üretiriz.
        id: call.id || `call_${index}`,
        name: call.name,
        arguments: call.args || "{}",
      }));
    this.byIndex.clear();
    return out;
  }
}

// -- Tel biçimi dönüşümleri ---------------------------------------------------

interface OpenAiChunk {
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: WireToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

export function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { role: message.role };

  if (message.role === "tool") {
    base["tool_call_id"] = message.toolCallId ?? "";
    base["content"] = typeof message.content === "string" ? message.content : "";
    return base;
  }

  base["content"] = Array.isArray(message.content)
    ? message.content.map(toWirePart)
    : message.content;

  if (message.toolCalls?.length) {
    base["tool_calls"] = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.name) base["name"] = message.name;
  return base;
}

function toWirePart(part: ContentPart): Record<string, unknown> {
  if (part.type === "image" && part.imageBase64) {
    return {
      type: "image_url",
      image_url: {
        url: `data:${part.mimeType ?? "image/png"};base64,${part.imageBase64}`,
      },
    };
  }
  return { type: "text", text: part.text ?? "" };
}

export function normalizeFinishReason(
  raw: string,
  sawToolCall: boolean,
): "stop" | "length" | "tool_calls" | "content_filter" | "error" {
  if (sawToolCall || raw === "tool_calls" || raw === "function_call") {
    return "tool_calls";
  }
  if (raw === "length" || raw === "max_tokens") return "length";
  if (raw === "content_filter") return "content_filter";
  if (raw === "error") return "error";
  return "stop";
}

export async function describeHttpFailure(response: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } | string };
    detail =
      typeof parsed.error === "string"
        ? parsed.error
        : (parsed.error?.message ?? text.slice(0, 300));
  } catch {
    detail = response.statusText;
  }

  const hint =
    response.status === 401 || response.status === 403
      ? " API anahtarını kontrol edin."
      : response.status === 429
        ? " Hız sınırına takıldı; biraz sonra tekrar deneyin."
        : "";

  return new ProviderError(
    `HTTP ${response.status}: ${detail}${hint}`,
    isRetriableStatus(response.status),
    response.status,
  );
}
