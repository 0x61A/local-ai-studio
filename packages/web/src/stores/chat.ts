import { create } from "zustand";
import {
  api,
  authHeaders,
  type ConversationSummary,
  type StoredMessage,
} from "../lib/api";
import { postEventStream } from "../lib/sse";

export interface DisplayMessage {
  id: string;
  role: StoredMessage["role"];
  content: string;
  reasoning: string;
  /** Akış sürerken true; tamamlanınca false. */
  streaming: boolean;
}

interface ChatState {
  conversations: ConversationSummary[];
  activeId: string | null;
  messages: DisplayMessage[];
  sending: boolean;
  error: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;

  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  removeConversation: (id: string) => Promise<void>;
  send: (text: string, options: { provider: string; model: string }) => Promise<void>;
  stop: () => void;
}

let activeAbort: AbortController | null = null;

export const useChat = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  messages: [],
  sending: false,
  error: null,
  usage: null,

  loadConversations: async () => {
    try {
      set({ conversations: await api.conversations() });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  openConversation: async (id) => {
    try {
      const { messages } = await api.conversation(id);
      set({
        activeId: id,
        error: null,
        usage: null,
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          content: message.content,
          reasoning: message.reasoning,
          streaming: false,
        })),
      });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  newConversation: () => set({ activeId: null, messages: [], error: null, usage: null }),

  removeConversation: async (id) => {
    await api.deleteConversation(id);
    if (get().activeId === id) get().newConversation();
    await get().loadConversations();
  },

  stop: () => {
    activeAbort?.abort();
    activeAbort = null;
    set({ sending: false });
    set((state) => ({
      messages: state.messages.map((message) =>
        message.streaming ? { ...message, streaming: false } : message,
      ),
    }));
  },

  send: async (text, options) => {
    if (get().sending) return;

    const userMessage: DisplayMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: text,
      reasoning: "",
      streaming: false,
    };
    const assistantId = `stream-${Date.now()}`;
    set((state) => ({
      sending: true,
      error: null,
      usage: null,
      messages: [
        ...state.messages,
        userMessage,
        { id: assistantId, role: "assistant", content: "", reasoning: "", streaming: true },
      ],
    }));

    const patch = (update: (message: DisplayMessage) => DisplayMessage) =>
      set((state) => ({
        messages: state.messages.map((message) =>
          message.id === assistantId ? update(message) : message,
        ),
      }));

    activeAbort = new AbortController();
    try {
      const stream = postEventStream(
        "/api/chat",
        {
          conversationId: get().activeId ?? undefined,
          message: text,
          provider: options.provider,
          model: options.model,
        },
        { headers: authHeaders(), signal: activeAbort.signal },
      );

      for await (const event of stream) {
        const data = event.data as Record<string, unknown>;
        switch (event.event) {
          case "conversation":
            set({ activeId: String(data["id"]) });
            break;
          case "text":
            patch((message) => ({
              ...message,
              content: message.content + String(data["delta"] ?? ""),
            }));
            break;
          case "reasoning":
            patch((message) => ({
              ...message,
              reasoning: message.reasoning + String(data["delta"] ?? ""),
            }));
            break;
          case "usage":
            set({
              usage: {
                promptTokens: Number(data["promptTokens"] ?? 0),
                completionTokens: Number(data["completionTokens"] ?? 0),
              },
            });
            break;
          case "error":
            set({ error: String(data["message"] ?? "Bilinmeyen hata") });
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        set({ error: (err as Error).message });
      }
    } finally {
      activeAbort = null;
      patch((message) => ({ ...message, streaming: false }));
      set({ sending: false });
      void get().loadConversations();
    }
  },
}));
