import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getSetting, setSetting } from "../store/settings.js";
import { defineTool, type Tool, type ToolResult } from "./types.js";

/**
 * MCP (Model Context Protocol) istemcisi.
 *
 * Hazır MCP sunucularını takıp araçlarını ajana kazandırır. Araç adları
 * `mcp__<sunucu>__<araç>` biçiminde önek alır; yerleşiklerle çakışmaz.
 *
 * Risk varsayılanı: MCP araçlarının ne yaptığını bilemeyiz. Sunucu
 * `readOnlyHint` bildirmediyse araç `write` sayılır ve onay ister.
 * Bilinmeyeni güvenli varsaymak, bilinmeyeni tehlikeli varsaymaktan
 * daha pahalıya patlar.
 */

const SETTING_KEY = "agent.mcpServers";
const CONNECT_TIMEOUT_MS = 30_000;

export const McpServerConfig = z.object({
  id: z.string().min(1).max(60).regex(/^[a-z0-9][a-z0-9_-]*$/i, "Yalnızca harf, rakam, - ve _"),
  label: z.string().min(1).max(100),
  transport: z.enum(["stdio", "http"]),
  /** stdio: çalıştırılacak komut. */
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** http: sunucu adresi. */
  url: z.string().url().optional(),
  enabled: z.boolean().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export interface McpServerStatus {
  id: string;
  label: string;
  transport: "stdio" | "http";
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  error: string | null;
}

interface Connection {
  client: Client;
  tools: Tool<never>[];
  error: string | null;
}

const connections = new Map<string, Connection>();

// -- Yapılandırma -------------------------------------------------------------

export function listServers(): McpServerConfig[] {
  return getSetting<McpServerConfig[]>(SETTING_KEY, []);
}

export function saveServer(config: McpServerConfig): McpServerConfig[] {
  const servers = listServers().filter((server) => server.id !== config.id);
  servers.push(config);
  setSetting(SETTING_KEY, servers);
  // Yapılandırma değişti: bağlantı yeniden kurulmalı.
  void disconnect(config.id);
  return servers;
}

export function removeServer(id: string): McpServerConfig[] {
  const servers = listServers().filter((server) => server.id !== id);
  setSetting(SETTING_KEY, servers);
  void disconnect(id);
  return servers;
}

export function serverStatuses(): McpServerStatus[] {
  return listServers().map((server) => {
    const connection = connections.get(server.id);
    return {
      id: server.id,
      label: server.label,
      transport: server.transport,
      enabled: server.enabled,
      connected: Boolean(connection && !connection.error),
      toolCount: connection?.tools.length ?? 0,
      error: connection?.error ?? null,
    };
  });
}

// -- Bağlantı -----------------------------------------------------------------

export async function connect(config: McpServerConfig): Promise<Connection> {
  const existing = connections.get(config.id);
  if (existing && !existing.error) return existing;

  const client = new Client(
    { name: "local-ai-studio", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    const transport =
      config.transport === "stdio"
        ? new StdioClientTransport({
            command: requireField(config.command, "command"),
            args: config.args ?? [],
            // Ortam bilerek dar tutulur: MCP sunucusuna tüm kabuk ortamını
            // (API anahtarları dahil) vermenin gereği yok.
            env: { PATH: process.env["PATH"] ?? "", ...config.env },
          })
        : new StreamableHTTPClientTransport(new URL(requireField(config.url, "url")));

    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, config.label);

    const listed = await client.listTools();
    const tools = (listed.tools ?? []).map((tool) => wrapTool(config.id, client, tool));
    const connection: Connection = { client, tools, error: null };
    connections.set(config.id, connection);
    return connection;
  } catch (err) {
    const connection: Connection = {
      client,
      tools: [],
      error: `${config.label}: ${(err as Error).message}`,
    };
    connections.set(config.id, connection);
    await client.close().catch(() => undefined);
    return connection;
  }
}

export async function disconnect(id: string): Promise<void> {
  const connection = connections.get(id);
  if (!connection) return;
  connections.delete(id);
  await connection.client.close().catch(() => undefined);
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => disconnect(id)));
}

/** Etkin sunucuların araçları. Bağlanamayan sunucu ajanı durdurmaz. */
export async function collectTools(): Promise<Tool<never>[]> {
  const enabled = listServers().filter((server) => server.enabled);
  const results = await Promise.all(enabled.map((server) => connect(server)));
  return results.flatMap((connection) => connection.tools);
}

// -- Araç sarmalama -----------------------------------------------------------

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function wrapTool(
  serverId: string,
  client: Client,
  descriptor: McpToolDescriptor,
): Tool<never> {
  const readOnly = descriptor.annotations?.readOnlyHint === true;

  return defineTool<never>({
    name: `mcp__${serverId}__${descriptor.name}`,
    description: descriptor.description ?? `${serverId} sunucusundan ${descriptor.name}`,
    // Sunucu salt okunur demediyse onay isteriz.
    risk: readOnly ? "read" : "write",
    // MCP kendi JSON Schema'sını verir; olduğu gibi sağlayıcıya geçer ve
    // doğrulama sunucuya bırakılır. Şemayı zod'a çevirip geri çevirmek
    // sapma üretirdi.
    schema: z.any() as never,
    parametersOverride: descriptor.inputSchema ?? { type: "object", properties: {} },
    async run(input, context): Promise<ToolResult> {
      if (!readOnly) {
        const approved = await context.requestApproval({
          toolName: `mcp__${serverId}__${descriptor.name}`,
          risk: "write",
          summary: `MCP aracı çalıştır: ${serverId}/${descriptor.name}`,
          arguments: input,
        });
        if (!approved) {
          return { content: "Kullanıcı MCP aracını reddetti.", isError: true };
        }
      }

      try {
        const response = await client.callTool({
          name: descriptor.name,
          arguments: (input ?? {}) as Record<string, unknown>,
        });
        return {
          content: renderContent(response["content"]),
          detail: response,
          isError: response["isError"] === true,
        };
      } catch (err) {
        return {
          content: `MCP aracı hata verdi: ${(err as Error).message}`,
          isError: true,
        };
      }
    },
  });
}

/** MCP içerik blokları -> düz metin. */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((block: Record<string, unknown>) => {
      if (block["type"] === "text") return String(block["text"] ?? "");
      if (block["type"] === "resource") {
        const resource = block["resource"] as Record<string, unknown> | undefined;
        return String(resource?.["text"] ?? `[kaynak: ${resource?.["uri"] ?? "?"}]`);
      }
      return `[${String(block["type"] ?? "bilinmeyen")} içeriği]`;
    })
    .filter(Boolean)
    .join("\n");
}

function requireField(value: string | undefined, field: string): string {
  if (!value) throw new Error(`MCP yapılandırmasında "${field}" alanı eksik.`);
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} ${ms / 1000} saniyede yanıt vermedi.`)), ms),
    ),
  ]);
}
