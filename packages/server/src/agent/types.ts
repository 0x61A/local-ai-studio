import { z } from "zod";

/**
 * Ajan araç sözleşmesi.
 *
 * Her araç risk seviyesini kendisi bildirir; onay kapısı bu alana bakar.
 * Şema `zod` ile yazılır ve sağlayıcıya giden JSON Schema ondan türetilir --
 * doğrulama ile modele anlatılan biçim birbirinden ayrılamaz.
 */

export type ToolRisk = "read" | "write" | "exec";

export interface ToolResult {
  /** Modele geri verilecek metin. */
  content: string;
  /** Arayüzde göstermek için yapılandırılmış ayrıntı. */
  detail?: unknown;
  isError?: boolean;
}

export interface ApprovalRequest {
  toolName: string;
  risk: ToolRisk;
  /** Kullanıcıya tek cümleyle ne yapılacağı. */
  summary: string;
  /** Dosya yazımlarında değişiklik önizlemesi. */
  diff?: string;
  /** Komut çalıştırmada tam komut satırı. */
  command?: string;
  arguments: unknown;
}

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
  /**
   * Onay kapısı. `read` araçları çağırmaz; `write`/`exec` araçları
   * çağırmak zorundadır. false dönerse araç iş yapmadan çıkmalıdır.
   */
  requestApproval(request: ApprovalRequest): Promise<boolean>;
}

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: z.ZodType<Input>;
  /**
   * Sağlayıcıya gönderilecek hazır JSON Schema. MCP araçları için kullanılır:
   * şema sunucudan geldiği gibi geçirilir, zod'dan yeniden türetilmez --
   * ikinci kez yorumlamak sapma üretirdi.
   */
  parametersOverride?: Record<string, unknown>;
  run(input: Input, context: ToolContext): Promise<ToolResult>;
}

/** Sağlayıcıya gönderilecek biçim. `$schema` anahtarı bazı sağlayıcıları rahatsız eder. */
export function toolParameters(tool: Tool<never>): Record<string, unknown> {
  if (tool.parametersOverride) {
    const { $schema: _ignored, ...rest } = tool.parametersOverride;
    return rest;
  }
  const schema = z.toJSONSchema(tool.schema as z.ZodType, {
    io: "input",
  }) as Record<string, unknown>;
  const { $schema: _dropped, ...rest } = schema;
  return rest;
}

export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

/** Ajan döngüsünün dışarıya yaydığı olaylar. */
export type AgentEvent =
  | { type: "step"; index: number }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; arguments: unknown }
  | { type: "approval_request"; id: string; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string; approved: boolean }
  | { type: "tool_end"; id: string; name: string; result: ToolResult; ms: number }
  | { type: "usage"; promptTokens: number; completionTokens: number }
  | { type: "error"; message: string }
  | { type: "done"; reason: "stop" | "max_steps" | "aborted" | "error" };
