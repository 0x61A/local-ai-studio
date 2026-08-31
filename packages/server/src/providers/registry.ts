import { streamAnthropic } from "./anthropic.js";
import { streamGemini } from "./gemini.js";
import { describeHttpFailure, streamOpenAiCompatible } from "./openai-compatible.js";
import { getSecret, hasSecret } from "../security/secrets.js";
import {
  PROVIDER_IDS,
  ProviderError,
  type ChatEvent,
  type ChatMessage,
  type ChatOptions,
  type ChatProvider,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderModel,
  type ToolDefinition,
} from "./types.js";

/**
 * Sağlayıcı kayıt defteri.
 *
 * Model listeleri canlı çekilir; kaynağa gömülü liste tutulmaz. Gömülü
 * listeler bayatlar ve her yeni model sürümünde kod değişikliği gerektirir --
 * referans projedeki katalogların düştüğü tuzak buydu.
 */

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  /** Anahtarın sırlar deposundaki adı. Yerel motorda boş. */
  secretName: string;
  /** Kullanıcıya anahtarı nereden alacağını söylemek için. */
  keyUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  llamacpp: {
    id: "llamacpp",
    label: "Yerel (llama.cpp)",
    capabilities: { tools: true, vision: true, embeddings: true, requiresApiKey: false },
    secretName: "",
    keyUrl: "",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    capabilities: { tools: true, vision: true, embeddings: true, requiresApiKey: true },
    secretName: "openai",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    capabilities: { tools: true, vision: true, embeddings: false, requiresApiKey: true },
    secretName: "anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    capabilities: { tools: true, vision: true, embeddings: true, requiresApiKey: true },
    secretName: "gemini",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    capabilities: { tools: true, vision: true, embeddings: false, requiresApiKey: true },
    secretName: "openrouter",
    keyUrl: "https://openrouter.ai/keys",
  },
};

/**
 * Yerel motorun taban adresini veren geri çağrı. Motor supervisor'ı
 * başlangıçta bunu doldurur; motor yüklü değilken null döner.
 */
let localBaseUrl: () => string | null = () => null;

export function setLocalBaseUrlResolver(resolver: () => string | null): void {
  localBaseUrl = resolver;
}

export function getProvider(id: ProviderId): ChatProvider {
  switch (id) {
    case "llamacpp":
      return localProvider();
    case "anthropic":
      return anthropicProvider();
    case "gemini":
      return geminiProvider();
    case "openai":
      return openAiStyleProvider("openai", "https://api.openai.com/v1");
    case "openrouter":
      return openAiStyleProvider("openrouter", "https://openrouter.ai/api/v1", {
        // OpenRouter atıf başlıkları; sıralamada kullanılır, zorunlu değil.
        "HTTP-Referer": "http://127.0.0.1",
        "X-Title": "Local AI Studio",
      });
  }
}

export function listProviderDescriptors(): Array<
  ProviderDescriptor & { hasKey: boolean }
> {
  return PROVIDER_IDS.map((id) => {
    const descriptor = PROVIDERS[id];
    return {
      ...descriptor,
      hasKey: descriptor.secretName ? hasSecret(descriptor.secretName) : true,
    };
  });
}

// -- Yerel motor --------------------------------------------------------------

function localProvider(): ChatProvider {
  const descriptor = PROVIDERS.llamacpp;
  return {
    id: descriptor.id,
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    isReady: async () => localBaseUrl() !== null,
    listModels: async () => {
      const base = localBaseUrl();
      if (!base) return [];
      return fetchOpenAiModels(base);
    },
    chat: (messages, options, tools) => {
      const base = requireLocal();
      return streamOpenAiCompatible({ baseUrl: base }, messages, options, tools);
    },
    embed: async (texts, model) => {
      const base = requireLocal();
      return fetchEmbeddings({ baseUrl: base }, texts, model);
    },
  };
}

function requireLocal(): string {
  const base = localBaseUrl();
  if (!base) {
    throw new ProviderError(
      "Yerel motor çalışmıyor. Önce Modeller sekmesinden bir model yükleyin.",
      false,
    );
  }
  return base;
}

// -- Bulut sağlayıcıları ------------------------------------------------------

function openAiStyleProvider(
  id: "openai" | "openrouter",
  baseUrl: string,
  headers?: Record<string, string>,
): ChatProvider {
  const descriptor = PROVIDERS[id];
  return {
    id,
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    isReady: async () => hasSecret(descriptor.secretName),
    listModels: async () =>
      fetchOpenAiModels(baseUrl, requireKey(descriptor.secretName, descriptor.label)),
    chat: (messages, options, tools) =>
      streamOpenAiCompatible(
        {
          baseUrl,
          apiKey: requireKey(descriptor.secretName, descriptor.label),
          ...(headers ? { headers } : {}),
        },
        messages,
        options,
        tools,
      ),
    embed:
      id === "openai"
        ? async (texts, model) =>
            fetchEmbeddings(
              { baseUrl, apiKey: requireKey(descriptor.secretName, descriptor.label) },
              texts,
              model,
            )
        : undefined,
  };
}

function anthropicProvider(): ChatProvider {
  const descriptor = PROVIDERS.anthropic;
  return {
    id: "anthropic",
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    isReady: async () => hasSecret(descriptor.secretName),
    listModels: async () => {
      const key = requireKey(descriptor.secretName, descriptor.label);
      const response = await fetch("https://api.anthropic.com/v1/models?limit=100", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      });
      if (!response.ok) throw await describeHttpFailure(response);
      const payload = (await response.json()) as {
        data?: Array<{ id?: string; display_name?: string }>;
      };
      return (payload.data ?? [])
        .filter((model) => model.id)
        .map((model) => ({
          id: model.id as string,
          label: model.display_name ?? (model.id as string),
          contextLength: 0,
        }));
    },
    chat: (messages, options, tools) =>
      streamAnthropic(
        { apiKey: requireKey(descriptor.secretName, descriptor.label) },
        messages,
        options,
        tools,
      ),
  };
}

function geminiProvider(): ChatProvider {
  const descriptor = PROVIDERS.gemini;
  return {
    id: "gemini",
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    isReady: async () => hasSecret(descriptor.secretName),
    listModels: async () => {
      const key = requireKey(descriptor.secretName, descriptor.label);
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
        { headers: { "x-goog-api-key": key } },
      );
      if (!response.ok) throw await describeHttpFailure(response);
      const payload = (await response.json()) as {
        models?: Array<{
          name?: string;
          displayName?: string;
          inputTokenLimit?: number;
          supportedGenerationMethods?: string[];
        }>;
      };
      return (payload.models ?? [])
        .filter(
          (model) =>
            model.name &&
            (model.supportedGenerationMethods ?? []).includes("generateContent"),
        )
        .map((model) => ({
          // API "models/gemini-2.0-flash" döner; istekte kısa ad kullanılır.
          id: (model.name as string).replace(/^models\//, ""),
          label: model.displayName ?? (model.name as string),
          contextLength: model.inputTokenLimit ?? 0,
        }));
    },
    chat: (messages, options, tools) =>
      streamGemini(
        { apiKey: requireKey(descriptor.secretName, descriptor.label) },
        messages,
        options,
        tools,
      ),
    embed: async (texts, model) => {
      const key = requireKey(descriptor.secretName, descriptor.label);
      const out: Float32Array[] = [];
      for (const text of texts) {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({ content: { parts: [{ text }] } }),
          },
        );
        if (!response.ok) throw await describeHttpFailure(response);
        const payload = (await response.json()) as {
          embedding?: { values?: number[] };
        };
        out.push(Float32Array.from(payload.embedding?.values ?? []));
      }
      return out;
    },
  };
}

// -- Ortak yardımcılar --------------------------------------------------------

async function fetchOpenAiModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ProviderModel[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw await describeHttpFailure(response);
  const payload = (await response.json()) as {
    data?: Array<{ id?: string; name?: string; context_length?: number }>;
  };
  return (payload.data ?? [])
    .filter((model) => model.id)
    .map((model) => ({
      id: model.id as string,
      label: model.name ?? (model.id as string),
      contextLength: model.context_length ?? 0,
    }));
}

async function fetchEmbeddings(
  config: { baseUrl: string; apiKey?: string },
  texts: string[],
  model: string,
): Promise<Float32Array[]> {
  const response = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!response.ok) throw await describeHttpFailure(response);
  const payload = (await response.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
  };
  // Sıra garanti değil; index alanına göre yerleştiririz.
  const out = new Array<Float32Array>(texts.length);
  (payload.data ?? []).forEach((item, position) => {
    out[item.index ?? position] = Float32Array.from(item.embedding ?? []);
  });
  return out.map((vector) => vector ?? new Float32Array());
}

function requireKey(secretName: string, label: string): string {
  const key = getSecret(secretName);
  if (!key) {
    throw new ProviderError(
      `${label} için API anahtarı tanımlı değil. Ayarlar sekmesinden ekleyin.`,
      false,
      401,
    );
  }
  return key;
}

export type { ChatEvent, ChatMessage, ChatOptions, ChatProvider, ToolDefinition };
