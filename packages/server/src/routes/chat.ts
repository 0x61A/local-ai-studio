import { z } from "zod";
import { llamaEngine } from "../engines/llama.js";
import { EventStream } from "../http/sse.js";
import type { Router } from "../http/router.js";
import { getProvider, setLocalBaseUrlResolver } from "../providers/registry.js";
import { PROVIDER_IDS, ProviderError, type ChatMessage } from "../providers/types.js";
import {
  appendMessage,
  createConversation,
  getConversation,
  listMessages,
  updateConversation,
} from "../store/conversations.js";
import { getPreferences } from "./settings.js";

/** Yerel sağlayıcı motorun canlı adresini buradan öğrenir. */
setLocalBaseUrlResolver(() => {
  const base = llamaEngine.baseUrl();
  return base ? `${base}/v1` : null;
});

const ChatBody = z.object({
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(200_000),
  provider: z.enum(PROVIDER_IDS).optional(),
  model: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  systemPrompt: z.string().max(20_000).optional(),
});

export function registerChatRoutes(router: Router): void {
  router.get("/api/providers/:id/models", {}, async ({ params }) => {
    const id = params["id"];
    if (!PROVIDER_IDS.includes(id as never)) {
      return { models: [], error: "Bilinmeyen sağlayıcı." };
    }
    const provider = getProvider(id as (typeof PROVIDER_IDS)[number]);
    try {
      return { models: await provider.listModels(), error: null };
    } catch (err) {
      // Anahtar yoksa ya da ağ yoksa liste boş döner; arayüz sebebi gösterir.
      return { models: [], error: (err as Error).message };
    }
  });

  /**
   * Sohbet. Yanıt normalleştirilmiş SSE olayları olarak akar; istemci
   * hangi sağlayıcının konuştuğunu bilmez.
   */
  router.post("/api/chat", { body: ChatBody }, async ({ body, res, req }) => {
    const preferences = getPreferences();
    const providerId = body.provider ?? preferences.defaultProvider;
    const model = body.model ?? preferences.defaultModel;
    const provider = getProvider(providerId);

    const stream = new EventStream(res);
    const abort = new AbortController();
    // Tarayıcı sekmesi kapanırsa sağlayıcıya gitmeyi bırak.
    req.on("close", () => abort.abort());

    try {
      if (!model) {
        stream.send("error", {
          message: "Model seçilmedi. Modeller sekmesinden bir model seçin.",
        });
        stream.send("done", { finishReason: "error" });
        return undefined;
      }

      const conversation = body.conversationId
        ? getConversation(body.conversationId)
        : createConversation({
            title: body.message.slice(0, 60),
            provider: providerId,
            model,
          });
      if (!conversation) {
        stream.send("error", { message: "Konuşma bulunamadı." });
        stream.send("done", { finishReason: "error" });
        return undefined;
      }
      stream.send("conversation", { id: conversation.id, title: conversation.title });

      const history = listMessages(conversation.id).map(
        (stored): ChatMessage => ({ role: stored.role, content: stored.content }),
      );
      const systemPrompt = body.systemPrompt ?? preferences.systemPrompt;
      const messages: ChatMessage[] = [
        ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
        ...history,
        { role: "user" as const, content: body.message },
      ];

      appendMessage(conversation.id, { role: "user", content: body.message });

      let answer = "";
      let reasoning = "";

      for await (const event of provider.chat(
        messages,
        {
          model,
          temperature: body.temperature ?? preferences.temperature,
          maxTokens: body.maxTokens ?? preferences.maxTokens,
          signal: abort.signal,
        },
      )) {
        if (stream.isClosed) break;
        switch (event.type) {
          case "text":
            answer += event.delta;
            stream.send("text", { delta: event.delta });
            break;
          case "reasoning":
            reasoning += event.delta;
            stream.send("reasoning", { delta: event.delta });
            break;
          case "usage":
            stream.send("usage", event);
            break;
          case "tool_call":
            // Faz 2'de ajan döngüsü bunu yürütecek; şimdilik görünür kılıyoruz.
            stream.send("tool_call", event.call);
            break;
          case "error":
            stream.send("error", { message: event.message });
            break;
          case "done":
            stream.send("done", { finishReason: event.finishReason });
            break;
        }
      }

      if (answer || reasoning) {
        appendMessage(conversation.id, {
          role: "assistant",
          content: answer,
          reasoning,
        });
        if (!conversation.title || conversation.title === body.message.slice(0, 60)) {
          updateConversation(conversation.id, {
            title: conversation.title || body.message.slice(0, 60),
            provider: providerId,
            model,
          });
        }
      }
    } catch (err) {
      const message =
        err instanceof ProviderError
          ? err.message
          : `Beklenmeyen hata: ${(err as Error).message}`;
      stream.send("error", { message });
      stream.send("done", { finishReason: "error" });
    } finally {
      stream.close();
    }
    return undefined;
  });
}
