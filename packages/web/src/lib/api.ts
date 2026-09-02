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

export type CatalogCategory =
  | "popular"
  | "reasoning"
  | "coding"
  | "lightweight"
  | "large"
  | "vision"
  | "embedding";

export interface CatalogModel {
  id: string;
  name: string;
  repo: string;
  category: CatalogCategory;
  description: string;
  parameters: string;
  contextLength: number;
  recommendedFile: string;
  sizeBytes: number;
  downloadUrl: string;
  minRamGb: number;
  tags: string[];
  isEmbedding: boolean;
  fits: boolean;
  fitsReason: string;
  estimatedMb: number;
}

export interface HfFile {
  path: string;
  sizeBytes: number;
  sha256: string | null;
  downloadUrl: string;
}

export type ToolRisk = "read" | "write" | "exec" | "computer";

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

export interface TaskProgress {
  id: string;
  title: string;
  state: "pending" | "running" | "done" | "failed";
  ms?: number;
}

export interface AgentStatus {
  workspace: string | null;
  running: boolean;
  pendingApprovals: Array<{ id: string; request: ApprovalRequest }>;
  alwaysAllowed: string[];
  mcpServers: McpStatus[];
  searchProviders: SearchProviderInfo[];
  /** Plan kipinde alt görevler; akış kopsa da sunucuda durur. */
  tasks: TaskProgress[];
  browser: { installed: boolean; open: boolean };
}

export type PowerMode = "performance" | "balanced" | "eco" | "custom";

export interface Preferences {
  defaultProvider: string;
  defaultModel: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  powerMode?: PowerMode;
  cpuThreads?: number;
  ubatchSize?: number;
  gpuOffload?: boolean;
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

export interface StoredImage {
  id: string;
  filename: string;
  prompt: string;
  negativePrompt: string;
  model: string;
  sampler: string;
  scheduler: string;
  steps: number;
  cfgScale: number;
  seed: number;
  width: number;
  height: number;
  source: "txt2img" | "img2img";
  parentId: string | null;
  hires: boolean;
  ms: number;
  favorite: boolean;
  createdAt: number;
}

export interface ImageJob {
  id: string;
  state: "queued" | "generating" | "saving" | "done" | "error" | "cancelled";
  prompt: string;
  batchCount: number;
  queuePosition: number;
  imageIds: string[];
  error: string | null;
  startedAt: number;
  ms: number;
}

export interface SdCapabilities {
  modelName: string;
  samplers: string[];
  schedulers: string[];
  upscalers: string[];
  defaults: Record<string, unknown>;
}

export interface ImageOverview {
  engine: {
    id: string;
    state: "stopped" | "starting" | "ready" | "error";
    model: string;
    port: number | null;
    error: string | null;
    footprintMb: number;
    ready: boolean;
  };
  model: string | null;
  models: Array<{ filename: string; sizeBytes: number }>;
  modelsDir: string;
  budget: MemoryBudget;
  jobs: ImageJob[];
  capabilities: SdCapabilities | null;
}

export interface GenerateImageRequest {
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  batchCount?: number;
  sampler?: string;
  scheduler?: string;
  hires?: {
    enabled: boolean;
    upscaler?: string;
    scale?: number;
    steps?: number;
    denoisingStrength?: number;
  };
  initImageId?: string;
  strength?: number;
}

export interface Voice {
  name: string;
  locale: string;
  sample: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  language: string;
  segments: TranscriptSegment[];
  ms: number;
}

export interface AudioOutput {
  filename: string;
  sizeBytes: number;
  createdAt: number;
}

export interface AudioOverview {
  speech: {
    binary: string | null;
    models: Array<{ filename: string; sizeBytes: number }>;
    modelsDir: string;
    cloudAvailable: boolean;
  };
  tts: { available: boolean; voices: Voice[] };
  outputs: AudioOutput[];
  maxAudioBytes: number;
}

export const api = {
  system: () => request<SystemInfo>("/api/system"),
  telemetry: () => request<Telemetry>("/api/telemetry"),
  health: () => request<HealthStatus>("/api/health"),

  models: () => request<{ models: LocalModel[]; budget: MemoryBudget }>("/api/models"),
  catalog: (lang?: "tr" | "en") =>
    request<{ catalog: CatalogModel[]; budget: MemoryBudget }>(
      lang ? `/api/models/catalog?lang=${lang}` : "/api/models/catalog",
    ),
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

  closeBrowser: () =>
    request<{ open: boolean }>("/api/agent/browser/close", { method: "POST" }),
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

  images: () => request<ImageOverview>("/api/images"),
  loadImageEngine: (filename: string) =>
    request<{ engine: ImageOverview["engine"] }>("/api/images/engine/load", {
      method: "POST",
      body: JSON.stringify({ filename }),
    }),
  unloadImageEngine: () =>
    request<{ engine: ImageOverview["engine"] }>("/api/images/engine/unload", {
      method: "POST",
    }),
  generateImage: (input: GenerateImageRequest) =>
    request<{ job: ImageJob }>("/api/images/generate", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  imageJobs: () => request<{ jobs: ImageJob[] }>("/api/images/jobs"),
  cancelImageJob: (id: string) =>
    request<{ ok: boolean }>(`/api/images/jobs/${id}/cancel`, { method: "POST" }),
  clearImageJobs: () =>
    request<{ jobs: ImageJob[] }>("/api/images/jobs/clear", { method: "POST" }),
  gallery: (query?: { q?: string; favorites?: boolean }) => {
    const params = new URLSearchParams();
    if (query?.q) params.set("q", query.q);
    if (query?.favorites) params.set("favorites", "1");
    const suffix = params.toString();
    return request<{ images: StoredImage[] }>(
      suffix ? `/api/images/gallery?${suffix}` : "/api/images/gallery",
    );
  },
  favoriteImage: (id: string, favorite: boolean) =>
    request<{ image: StoredImage }>(`/api/images/${id}/favorite`, {
      method: "POST",
      body: JSON.stringify({ favorite }),
    }),
  deleteImage: (id: string) =>
    request<{ ok: boolean }>(`/api/images/${id}`, { method: "DELETE" }),

  audio: () => request<AudioOverview>("/api/audio"),
  transcribe: (input: {
    audio: string;
    provider?: "local" | "openai";
    model?: string;
    language?: string;
    translate?: boolean;
  }) =>
    request<{ transcript: Transcript }>("/api/audio/transcribe", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  speak: (text: string, voice?: string, rate?: number) =>
    request<{ speech: { filename: string; bytes: number; voice: string; ms: number }; outputs: AudioOutput[] }>(
      "/api/audio/speak",
      { method: "POST", body: JSON.stringify({ text, ...(voice ? { voice } : {}), ...(rate ? { rate } : {}) }) },
    ),
  audioOutputs: () => request<{ outputs: AudioOutput[] }>("/api/audio/outputs"),
  deleteAudioOutput: (filename: string) =>
    request<{ outputs: AudioOutput[] }>(
      `/api/audio/outputs/${encodeURIComponent(filename)}`,
      { method: "DELETE" },
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

/**
 * Görsel dosyasını blob URL olarak getirir.
 *
 * `<img src>` özel başlık gönderemez; token'ı adres çubuğuna koymamak için
 * dosya `fetch` ile çekilip nesne URL'i üretilir. Çağıran taraf işi
 * bitince `URL.revokeObjectURL` çağırmalı.
 */
export async function fetchImageObjectUrl(filename: string): Promise<string> {
  const response = await fetch(`/api/images/file/${encodeURIComponent(filename)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`Görsel yüklenemedi: HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

/** Ses dosyasını blob URL olarak getirir; bkz. fetchImageObjectUrl. */
export async function fetchAudioObjectUrl(filename: string): Promise<string> {
  const response = await fetch(`/api/audio/file/${encodeURIComponent(filename)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`Ses yüklenemedi: HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

/** Ajanın aldığı ekran görüntüsü; bkz. fetchImageObjectUrl. */
export async function fetchScreenshotObjectUrl(filename: string): Promise<string> {
  const response = await fetch(`/api/agent/screenshot/${encodeURIComponent(filename)}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error(`Ekran görüntüsü yüklenemedi: HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}
