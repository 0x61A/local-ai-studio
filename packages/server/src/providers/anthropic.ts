import { readSseStream } from "./sse.js";
import { describeHttpFailure } from "./openai-compatible.js";
import {
  ProviderError,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type ContentPart,
  type FinishReason,
  type ToolDefinition,
} from "./types.js";

/**
 * Anthropic Messages API adaptörü.
 *
 * OpenAI telinden üç önemli farkı var, hepsi burada kapsanır:
 *  1. `system` mesaj listesinde değil, gövdenin tepesinde ayrı bir alan.
 *  2. `max_tokens` zorunlu.
 *  3. Araç çağrıları içerik blokları hâlinde akar; argümanlar
 *     `input_json_delta` parçalarıyla gelir.
 */

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
  baseUrl?: string;
  apiKey: string;
}

export async function* streamAnthropic(
  config: AnthropicConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  tools?: ToolDefinition[],
): AsyncGenerator<ChatEvent> {
  const { system, turns } = splitSystem(messages);

  const body: Record<string, unknown> = {
    model: options.model,
    // Anthropic'te zorunlu alan; verilmezse istek reddedilir.
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: turns,
    stream: true,
  };
  if (system) body["system"] = system;
  if (options.temperature !== undefined) body["temperature"] = options.temperature;
  if (options.topP !== undefined) body["top_p"] = options.topP;
  if (options.stop?.length) body["stop_sequences"] = options.stop;
  if (tools?.length) {
    body["tools"] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  const response = await fetch(
    `${config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    },
  );

  if (!response.ok || !response.body) throw await describeHttpFailure(response);

  // Araç çağrıları blok indeksine göre birikir; argümanlar parça parça gelir.
  const blocks = new Map<number, { id: string; name: string; json: string }>();
  let finishReason: FinishReason = "stop";
  let sawToolCall = false;

  for await (const event of readSseStream(response.body, options.signal)) {
    let payload: AnthropicEvent;
    try {
      payload = JSON.parse(event.data) as AnthropicEvent;
    } catch {
      continue;
    }

    switch (payload.type) {
      case "error":
        throw new ProviderError(
          payload.error?.message ?? "Anthropic hatası",
          payload.error?.type === "overloaded_error",
        );

      case "content_block_start": {
        const block = payload.content_block;
        if (block?.type === "tool_use") {
          sawToolCall = true;
          blocks.set(payload.index ?? 0, {
            id: block.id ?? "",
            name: block.name ?? "",
            json: "",
          });
        }
        break;
      }

      case "content_block_delta": {
        const delta = payload.delta;
        if (delta?.type === "text_delta" && delta.text) {
          yield { type: "text", delta: delta.text };
        } else if (delta?.type === "thinking_delta" && delta.thinking) {
          yield { type: "reasoning", delta: delta.thinking };
        } else if (delta?.type === "input_json_delta") {
          const current = blocks.get(payload.index ?? 0);
          if (current) current.json += delta.partial_json ?? "";
        }
        break;
      }

      case "message_delta": {
        if (payload.delta?.stop_reason) {
          finishReason = mapStopReason(payload.delta.stop_reason);
        }
        if (payload.usage) {
          yield {
            type: "usage",
            promptTokens: payload.usage.input_tokens ?? 0,
            completionTokens: payload.usage.output_tokens ?? 0,
          };
        }
        break;
      }

      case "message_start": {
        const usage = payload.message?.usage;
        if (usage) {
          yield {
            type: "usage",
            promptTokens: usage.input_tokens ?? 0,
            completionTokens: usage.output_tokens ?? 0,
          };
        }
        break;
      }
    }
  }

  for (const [, block] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    if (!block.name) continue;
    yield {
      type: "tool_call",
      call: { id: block.id, name: block.name, arguments: block.json || "{}" },
    };
  }

  yield { type: "done", finishReason: sawToolCall ? "tool_calls" : finishReason };
}

// -- Tel biçimi ---------------------------------------------------------------

interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string; type?: string };
}

/** Anthropic sistem istemini mesaj listesinde kabul etmez; ayırıp birleştiririz. */
export function splitSystem(messages: ChatMessage[]): {
  system: string;
  turns: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const turns: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(flattenText(message.content));
      continue;
    }
    turns.push(toAnthropicTurn(message));
  }
  return { system: systemParts.join("\n\n"), turns };
}

function toAnthropicTurn(message: ChatMessage): Record<string, unknown> {
  // Araç sonuçları Anthropic'te bir "user" mesajının içerik bloğudur.
  if (message.role === "tool") {
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: flattenText(message.content),
        },
      ],
    };
  }

  const content: Array<Record<string, unknown>> = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) content.push(toAnthropicPart(part));
  } else if (message.content) {
    content.push({ type: "text", text: message.content });
  }

  for (const call of message.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: safeJson(call.arguments),
    });
  }

  return {
    role: message.role === "assistant" ? "assistant" : "user",
    // Anthropic boş içerik listesini reddeder.
    content: content.length ? content : [{ type: "text", text: "" }],
  };
}

function toAnthropicPart(part: ContentPart): Record<string, unknown> {
  if (part.type === "image" && part.imageBase64) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: part.mimeType ?? "image/png",
        data: part.imageBase64,
      },
    };
  }
  return { type: "text", text: part.text ?? "" };
}

export function mapStopReason(raw: string): FinishReason {
  if (raw === "max_tokens") return "length";
  if (raw === "tool_use") return "tool_calls";
  if (raw === "refusal") return "content_filter";
  return "stop";
}

function flattenText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

/** Model bozuk JSON üretebilir; istek gövdesini kırmasın diye boşa düşer. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
