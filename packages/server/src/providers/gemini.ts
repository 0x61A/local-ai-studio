import { readSseStream } from "./sse.js";
import { describeHttpFailure } from "./openai-compatible.js";
import {
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type ContentPart,
  type FinishReason,
  type ToolDefinition,
} from "./types.js";

/**
 * Google Gemini (generativelanguage) adaptörü.
 *
 * Farkları:
 *  - Roller "user" / "model"; sistem istemi `systemInstruction` alanında.
 *  - Araçlar tek bir `functionDeclarations` dizisinde toplanır.
 *  - Araç çağrısı parçalanmadan tam gelir (argüman biriktirme gerekmez).
 *  - Anahtar başlıkta: `x-goog-api-key` (sorgu dizesine koymayız, URL'ler
 *    loglara ve tarayıcı geçmişine sızar).
 */

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiConfig {
  baseUrl?: string;
  apiKey: string;
}

export async function* streamGemini(
  config: GeminiConfig,
  messages: ChatMessage[],
  options: ChatOptions,
  tools?: ToolDefinition[],
): AsyncGenerator<ChatEvent> {
  const { systemInstruction, contents } = toGeminiContents(messages);

  const generationConfig: Record<string, unknown> = {};
  if (options.temperature !== undefined) generationConfig["temperature"] = options.temperature;
  if (options.topP !== undefined) generationConfig["topP"] = options.topP;
  if (options.maxTokens !== undefined) generationConfig["maxOutputTokens"] = options.maxTokens;
  if (options.stop?.length) generationConfig["stopSequences"] = options.stop;

  const body: Record<string, unknown> = { contents };
  if (systemInstruction) {
    body["systemInstruction"] = { parts: [{ text: systemInstruction }] };
  }
  if (Object.keys(generationConfig).length) {
    body["generationConfig"] = generationConfig;
  }
  if (tools?.length) {
    body["tools"] = [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }

  const base = config.baseUrl ?? DEFAULT_BASE;
  const model = encodeURIComponent(options.model);
  const response = await fetch(
    `${base}/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Anahtar sorgu dizesine değil başlığa: URL'ler loglanır.
        "x-goog-api-key": config.apiKey,
      },
      body: JSON.stringify(body),
      signal: options.signal ?? null,
    },
  );

  if (!response.ok || !response.body) throw await describeHttpFailure(response);

  let finishReason: FinishReason = "stop";
  let sawToolCall = false;
  let callIndex = 0;

  for await (const event of readSseStream(response.body, options.signal)) {
    let payload: GeminiChunk;
    try {
      payload = JSON.parse(event.data) as GeminiChunk;
    } catch {
      continue;
    }

    if (payload.usageMetadata) {
      yield {
        type: "usage",
        promptTokens: payload.usageMetadata.promptTokenCount ?? 0,
        completionTokens: payload.usageMetadata.candidatesTokenCount ?? 0,
      };
    }

    const candidate = payload.candidates?.[0];
    if (!candidate) continue;

    for (const part of candidate.content?.parts ?? []) {
      if (part.thought === true && part.text) {
        yield { type: "reasoning", delta: part.text };
      } else if (part.text) {
        yield { type: "text", delta: part.text };
      }
      if (part.functionCall?.name) {
        sawToolCall = true;
        callIndex += 1;
        yield {
          type: "tool_call",
          call: {
            id: `call_${callIndex}`,
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        };
      }
    }

    if (candidate.finishReason) {
      finishReason = mapFinishReason(candidate.finishReason);
    }
  }

  yield { type: "done", finishReason: sawToolCall ? "tool_calls" : finishReason };
}

// -- Tel biçimi ---------------------------------------------------------------

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

export function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: string;
  contents: Array<Record<string, unknown>>;
} {
  const systemParts: string[] = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(flattenText(message.content));
      continue;
    }

    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.name ?? message.toolCallId ?? "tool",
              response: { result: flattenText(message.content) },
            },
          },
        ],
      });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) parts.push(toGeminiPart(part));
    } else if (message.content) {
      parts.push({ text: message.content });
    }

    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: safeJson(call.arguments) } });
    }

    if (parts.length === 0) parts.push({ text: "" });
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }

  return { systemInstruction: systemParts.join("\n\n"), contents };
}

function toGeminiPart(part: ContentPart): Record<string, unknown> {
  if (part.type === "image" && part.imageBase64) {
    return {
      inlineData: { mimeType: part.mimeType ?? "image/png", data: part.imageBase64 },
    };
  }
  return { text: part.text ?? "" };
}

export function mapFinishReason(raw: string): FinishReason {
  if (raw === "MAX_TOKENS") return "length";
  if (raw === "SAFETY" || raw === "PROHIBITED_CONTENT" || raw === "BLOCKLIST") {
    return "content_filter";
  }
  if (raw === "STOP") return "stop";
  return "stop";
}

function flattenText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
