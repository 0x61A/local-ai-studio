import { TOKEN_FRAGMENT_KEY } from "@studio/shared/constants";
import { readSession, writeSession } from "./storage";
import type { SystemInfo, Telemetry, HealthStatus } from "@studio/shared";

const TOKEN_STORAGE_KEY = "studio.session-token";

/**
 * Token launcher tarafindan URL fragment'inda verilir (#t=...). Fragment
 * sunucuya gonderilmez, gecmise/loglara sizmasin diye okunur okunmaz
 * adres cubugundan temizlenir.
 */
function claimToken(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const fromUrl = new URLSearchParams(hash).get(TOKEN_FRAGMENT_KEY);
  if (fromUrl) {
    writeSession(TOKEN_STORAGE_KEY, fromUrl);
    history.replaceState(null, "", window.location.pathname);
    return fromUrl;
  }
  return readSession(TOKEN_STORAGE_KEY);
}

let token = claimToken();

export function hasToken(): boolean {
  return token !== null;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as
      | { error?: { code?: string; message?: string } }
      | null;
    throw new ApiRequestError(
      res.status,
      payload?.error?.code ?? "unknown",
      payload?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export function authHeaders(): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

// -- Sunucu sözleşmeleri ------------------------------------------------------

export interface LocalModel {
  filename: string;
  sizeBytes: number;
  architecture: string;
  parameters: string;
  quantization: string;
  contextLength: number;
  isEmbedding: boolean;
  fits: boolean;
  planReason: string;
  estimatedMb: number;
  error: string | null;
}

export interface MemoryBudget {
  budgetMb: number;
  usedMb: number;
  freeMb: number;
  unifiedMemory: boolean;
}

export interface EngineInfo {
  id: string;
  state: "stopped" | "starting" | "ready" | "error";
  model: string;
  port: number | null;
  error: string | null;
  footprintMb: number;
  progress: number;
  plan: { contextSize: number; gpuLayers: number; reason: string } | null;
  budget: MemoryBudget;
}

export interface ProviderInfo {
  id: string;
  label: string;
  capabilities: {
    tools: boolean;
    vision: boolean;
    embeddings: boolean;
    requiresApiKey: boolean;
  };
  keyUrl: string;
  hasKey: boolean;
  maskedKey: string | null;
}

export interface ProviderModel {
  id: string;
  label: string;
  contextLength: number;
}

export interface DownloadTask {
  id: string;
  filename: string;
  state: "queued" | "downloading" | "verifying" | "done" | "error" | "cancelled";
  totalBytes: number;
  downloadedBytes: number;
  bytesPerSecond: number;
  etaSeconds: number;
  error: string | null;
  resumed: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  tags: string[];
}

export interface StoredMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning: string;
  createdAt: number;
  seq: number;
}

export interface HfModelSummary {
  id: string;
  downloads: number;
  likes: number;
  gated: boolean;
}

export interface HfFile {
  path: string;
  sizeBytes: number;
  sha256: string | null;
  downloadUrl: string;
}

export type ToolRisk = "read" | "write" | "exec";

export interface ToolInfo {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: Record<string, unknown>;
}

export interface ApprovalRequest {
  toolName: string;
  risk: ToolRisk;
  summary: string;
  diff?: string;
  command?: string;
  arguments: unknown;
}

export interface McpServer {
  id: string;
  label: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

export interface McpStatus {
  id: string;
  label: string;
  connected: boolean;
  toolCount: number;
  error: string | null;
}

export interface SearchProviderInfo {
  id: string;
  label: string;
  requiresApiKey: boolean;
  keyUrl: string;
  available: boolean;
}

export interface AgentStatus {
  workspace: string | null;
  running: boolean;
  pendingApprovals: Array<{ id: string; request: ApprovalRequest }>;
  alwaysAllowed: string[];
  mcpServers: McpStatus[];
  searchProviders: SearchProviderInfo[];
}

export interface Preferences {
  defaultProvider: string;
  defaultModel: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  embedProvider: string;
  embedModel: string;
  dimensions: number;
  createdAt: number;
  documentCount: number;
  chunkCount: number;
}

export interface KnowledgeDocument {
  id: string;
  collectionId: string;
  name: string;
  kind: string;
  sizeBytes: number;
  pageCount: number;
  chunkCount: number;
  status: "pending" | "extracting" | "embedding" | "ready" | "error";
  error: string;
  createdAt: number;
}

export interface IngestJob {
  documentId: string;
  collectionId: string;
  name: string;
  status: "queued" | "extracting" | "embedding" | "done" | "error";
  progress: number;
  chunkCount: number;
  error: string | null;
}

export interface SourceRef {
  index: number;
  documentId: string;
  documentName: string;
  page: number;
  heading: string;
  snippet: string;
  score: number;
  matchedBy: "semantic" | "keyword" | "both";
}

export interface EmbeddingEngineInfo {
  id: string;
  state: "stopped" | "starting" | "ready" | "error";
  model: string;
  port: number | null;
  error: string | null;
  footprintMb: number;
  ready: boolean;
  budget: MemoryBudget;
}

export interface KnowledgeOverview {
  collections: KnowledgeCollection[];
  jobs: IngestJob[];
  embedding: EmbeddingEngineInfo;
  localEmbeddingModels: LocalModel[];
  supportedExtensions: string[];
  maxUploadBytes: number;
}

export const api = {
  system: () => request<SystemInfo>("/api/system"),
  telemetry: () => request<Telemetry>("/api/telemetry"),
  health: () => request<HealthStatus>("/api/health"),

  models: () => request<{ models: LocalModel[]; budget: MemoryBudget }>("/api/models"),
  deleteModel: (filename: string) =>
    request<{ ok: boolean }>(`/api/models/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    }),

  engine: () => request<EngineInfo>("/api/engine"),
  loadEngine: (filename: string, contextSize?: number) =>
    request<EngineInfo>("/api/engine/load", {
      method: "POST",
      body: JSON.stringify(contextSize ? { filename, contextSize } : { filename }),
    }),
  unloadEngine: () => request<EngineInfo>("/api/engine/unload", { method: "POST" }),

  providers: () => request<ProviderInfo[]>("/api/providers"),
  providerModels: (id: string) =>
    request<{ models: ProviderModel[]; error: string | null }>(
      `/api/providers/${id}/models`,
    ),
  setProviderKey: (provider: string, apiKey: string) =>
    request<{ ok: boolean; masked: string }>("/api/providers/key", {
      method: "POST",
      body: JSON.stringify({ provider, apiKey }),
    }),
  deleteProviderKey: (provider: string) =>
    request<{ ok: boolean }>(`/api/providers/${provider}/key`, { method: "DELETE" }),

  settings: () => request<{ preferences: Preferences }>("/api/settings"),
  saveSettings: (patch: Partial<Preferences>) =>
    request<{ preferences: Preferences }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(patch),
    }),

  conversations: () => request<ConversationSummary[]>("/api/conversations"),
  conversation: (id: string) =>
    request<{ conversation: ConversationSummary; messages: StoredMessage[] }>(
      `/api/conversations/${id}`,
    ),
  deleteConversation: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}`, { method: "DELETE" }),
  search: (q: string) =>
    request<Array<{ conversationId: string; title: string; snippet: string }>>(
      `/api/search?q=${encodeURIComponent(q)}`,
    ),

  hfSearch: (q: string) =>
    request<HfModelSummary[]>(`/api/hf/search?q=${encodeURIComponent(q)}`),
  hfModel: (repo: string) =>
    request<{ files: HfFile[]; recommended: string | null; budget: MemoryBudget }>(
      `/api/hf/models/${repo}`,
    ),

  agentStatus: () => request<AgentStatus>("/api/agent/status"),
  agentTools: () => request<ToolInfo[]>("/api/agent/tools"),
  setWorkspace: (path: string) =>
    request<{ workspace: string }>("/api/agent/workspace", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  clearWorkspace: () =>
    request<{ workspace: null }>("/api/agent/workspace", { method: "DELETE" }),
  approve: (id: string, approved: boolean, always = false) =>
    request<{ ok: boolean }>("/api/agent/approve", {
      method: "POST",
      body: JSON.stringify({ id, approved, always }),
    }),
  stopAgent: () => request<{ ok: boolean }>("/api/agent/stop", { method: "POST" }),
  mcpServers: () =>
    request<{ servers: McpServer[]; statuses: McpStatus[] }>("/api/agent/mcp"),
  saveMcpServer: (config: McpServer) =>
    request<{ servers: McpServer[]; statuses: McpStatus[] }>("/api/agent/mcp", {
      method: "POST",
      body: JSON.stringify(config),
    }),
  deleteMcpServer: (id: string) =>
    request<{ servers: McpServer[]; statuses: McpStatus[] }>(`/api/agent/mcp/${id}`, {
      method: "DELETE",
    }),

  knowledge: () => request<KnowledgeOverview>("/api/knowledge"),
  createCollection: (name: string, embedProvider: string, embedModel: string) =>
    request<{ collection: KnowledgeCollection }>("/api/knowledge/collections", {
      method: "POST",
      body: JSON.stringify({ name, embedProvider, embedModel }),
    }),
  renameCollection: (id: string, name: string) =>
    request<{ collection: KnowledgeCollection }>(
      `/api/knowledge/collections/${id}/rename`,
      { method: "POST", body: JSON.stringify({ name }) },
    ),
  deleteCollection: (id: string) =>
    request<{ collections: KnowledgeCollection[] }>(`/api/knowledge/collections/${id}`, {
      method: "DELETE",
    }),
  collectionDocuments: (id: string) =>
    request<{ documents: KnowledgeDocument[] }>(
      `/api/knowledge/collections/${id}/documents`,
    ),
  uploadDocument: (collectionId: string, name: string, content: string) =>
    request<{ document: KnowledgeDocument }>(
      `/api/knowledge/collections/${collectionId}/documents`,
      { method: "POST", body: JSON.stringify({ name, content }) },
    ),
  deleteKnowledgeDocument: (id: string) =>
    request<{ ok: boolean }>(`/api/knowledge/documents/${id}`, { method: "DELETE" }),
  knowledgeJobs: () => request<{ jobs: IngestJob[] }>("/api/knowledge/jobs"),
  clearKnowledgeJobs: () =>
    request<{ jobs: IngestJob[] }>("/api/knowledge/jobs/clear", { method: "POST" }),
  knowledgeSearch: (collectionId: string, query: string, topK?: number) =>
    request<{ sources: SourceRef[] }>("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify(topK ? { collectionId, query, topK } : { collectionId, query }),
    }),
  loadEmbedding: (filename: string) =>
    request<{ embedding: Omit<EmbeddingEngineInfo, "ready" | "budget"> }>(
      "/api/knowledge/embedding/load",
      { method: "POST", body: JSON.stringify({ filename }) },
    ),
  unloadEmbedding: () =>
    request<{ embedding: Omit<EmbeddingEngineInfo, "ready" | "budget"> }>(
      "/api/knowledge/embedding/unload",
      { method: "POST" },
    ),

  downloads: () => request<DownloadTask[]>("/api/downloads"),
  startDownload: (url: string, filename: string, sha256?: string | null) =>
    request<DownloadTask>("/api/downloads", {
      method: "POST",
      body: JSON.stringify(sha256 ? { url, filename, sha256 } : { url, filename }),
    }),
  cancelDownload: (id: string) =>
    request<{ ok: boolean }>(`/api/downloads/${id}`, { method: "DELETE" }),
  clearDownloads: () =>
    request<{ ok: boolean }>("/api/downloads/clear", { method: "POST" }),
};
