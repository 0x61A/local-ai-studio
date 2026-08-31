import { create } from "zustand";
import {
  api,
  authHeaders,
  type AgentStatus,
  type ApprovalRequest,
  type ToolInfo,
} from "../lib/api";
import { postEventStream } from "../lib/sse";

export interface TranscriptEntry {
  id: string;
  kind: "text" | "tool" | "approval" | "error";
  /** text */
  content?: string;
  /** tool */
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: { content: string; isError?: boolean };
  ms?: number;
  /** approval */
  request?: ApprovalRequest;
  approved?: boolean | null;
  /** akış sürüyor mu */
  streaming?: boolean;
}

interface AgentState {
  status: AgentStatus | null;
  tools: ToolInfo[];
  entries: TranscriptEntry[];
  running: boolean;
  step: number;
  error: string | null;

  refresh: () => Promise<void>;
  chooseWorkspace: (path: string) => Promise<void>;
  clearWorkspace: () => Promise<void>;
  run: (message: string, options: { provider: string; model: string }) => Promise<void>;
  approve: (id: string, approved: boolean, always?: boolean) => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
}

let abort: AbortController | null = null;

export const useAgent = create<AgentState>((set, get) => ({
  status: null,
  tools: [],
  entries: [],
  running: false,
  step: 0,
  error: null,

  refresh: async () => {
    try {
      const [status, tools] = await Promise.all([api.agentStatus(), api.agentTools()]);
      set({ status, tools, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  chooseWorkspace: async (path) => {
    try {
      await api.setWorkspace(path);
      await get().refresh();
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  clearWorkspace: async () => {
    await api.clearWorkspace();
    await get().refresh();
  },

  reset: () => set({ entries: [], error: null, step: 0 }),

  approve: async (id, approved, always = false) => {
    try {
      await api.approve(id, approved, always);
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.id === id ? { ...entry, approved } : entry,
        ),
      }));
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  stop: async () => {
    abort?.abort();
    await api.stopAgent().catch(() => undefined);
    set({ running: false });
  },

  run: async (message, options) => {
    if (get().running) return;
    set({
      running: true,
      error: null,
      step: 0,
      entries: [
        ...get().entries,
        { id: `user-${Date.now()}`, kind: "text", content: message },
      ],
    });

    abort = new AbortController();
    const push = (entry: TranscriptEntry) =>
      set((state) => ({ entries: [...state.entries, entry] }));
    const patch = (id: string, update: Partial<TranscriptEntry>) =>
      set((state) => ({
        entries: state.entries.map((entry) =>
          entry.id === id ? { ...entry, ...update } : entry,
        ),
      }));

    let textId: string | null = null;

    try {
      for await (const event of postEventStream(
        "/api/agent/run",
        { message, provider: options.provider, model: options.model },
        { headers: authHeaders(), signal: abort.signal },
      )) {
        const data = event.data as Record<string, unknown>;
        switch (event.event) {
          case "step":
            set({ step: Number(data["index"] ?? 0) + 1 });
            // Her adımda yeni bir metin bloğu başlar.
            textId = null;
            break;

          case "text": {
            const delta = String(data["delta"] ?? "");
            if (!textId) {
              textId = `text-${Date.now()}-${Math.random()}`;
              push({ id: textId, kind: "text", content: delta, streaming: true });
            } else {
              set((state) => ({
                entries: state.entries.map((entry) =>
                  entry.id === textId
                    ? { ...entry, content: (entry.content ?? "") + delta }
                    : entry,
                ),
              }));
            }
            break;
          }

          case "tool_start":
            push({
              id: String(data["id"]),
              kind: "tool",
              toolName: String(data["name"]),
              toolArgs: data["arguments"],
              streaming: true,
            });
            break;

          case "tool_end":
            patch(String(data["id"]), {
              toolResult: data["result"] as TranscriptEntry["toolResult"],
              ms: Number(data["ms"] ?? 0),
              streaming: false,
            });
            break;

          case "approval_request":
            push({
              id: String(data["id"]),
              kind: "approval",
              request: data["request"] as ApprovalRequest,
              approved: null,
            });
            break;

          case "approval_resolved":
            patch(String(data["id"]), { approved: Boolean(data["approved"]) });
            break;

          case "error":
            push({
              id: `err-${Date.now()}`,
              kind: "error",
              content: String(data["message"] ?? ""),
            });
            break;
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        set({ error: (err as Error).message });
      }
    } finally {
      abort = null;
      if (textId) patch(textId, { streaming: false });
      set({ running: false });
      void get().refresh();
    }
  },
}));
