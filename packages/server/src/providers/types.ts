/**
 * Sağlayıcı soyutlaması.
 *
 * Yerel llama.cpp ile bulut API'ları aynı arayüzün arkasındadır; sohbet
 * döngüsü ve (faz 2'de) ajan döngüsü hangi sağlayıcıyla konuştuğunu bilmez.
 * Sağlayıcıya özgü tel biçimi yalnızca adaptörlerin içinde kalır.
 */

export const PROVIDER_IDS = [
  "llamacpp",
  "openai",
  "anthropic",
  "gemini",
  "openrouter",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ContentPart {
  type: "text" | "image";
  text?: string;
  /** Ham base64; data URL öneki olmadan. */
  imageBase64?: string;
  mimeType?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Ham JSON metni. Ayrıştırma çağıran tarafın işi -- model bozuk JSON üretebilir. */
  arguments: string;
}

export interface ChatMessage {
  role: MessageRole;
  content: string | ContentPart[];
  /** Yalnızca assistant: modelin istediği araç çağrıları. */
  toolCalls?: ToolCall[];
  /** Yalnızca tool: hangi çağrının yanıtı olduğu. */
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema nesnesi. */
  parameters: Record<string, unknown>;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "aborted";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "done"; finishReason: FinishReason }
  | { type: "error"; message: string; retriable: boolean };

export interface ChatOptions {
  model: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stop?: string[];
  seed?: number;
  signal?: AbortSignal;
}

export interface ProviderCapabilities {
  tools: boolean;
  vision: boolean;
  embeddings: boolean;
  /** Yerel motorlar API anahtarı istemez. */
  requiresApiKey: boolean;
}

export interface ProviderModel {
  id: string;
  label: string;
  /** Bilinmiyorsa 0. */
  contextLength: number;
}

export interface ChatProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** Sağlayıcı kullanılabilir mi (anahtar var mı, motor ayakta mı). */
  isReady(): Promise<boolean>;
  listModels(): Promise<ProviderModel[]>;
  chat(
    messages: ChatMessage[],
    options: ChatOptions,
    tools?: ToolDefinition[],
  ): AsyncIterable<ChatEvent>;
  embed?(texts: string[], model: string): Promise<Float32Array[]>;
}

/** Sağlayıcı hatalarını tek tipe indirger; yeniden denenebilirliği taşır. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** 408/429 ve 5xx yeniden denenebilir; 4xx'in kalanı istemci hatasıdır. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
