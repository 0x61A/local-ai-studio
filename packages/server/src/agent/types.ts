import { z } from "zod";

/**
 * Ajan araç sözleşmesi.
 *
 * Her araç risk seviyesini kendisi bildirir; onay kapısı bu alana bakar.
 * Şema `zod` ile yazılır ve sağlayıcıya giden JSON Schema ondan türetilir --
 * doğrulama ile modele anlatılan biçim birbirinden ayrılamaz.
 */

/**
 * Araç risk seviyesi. `read` serbest çalışır; kalan üçü onay kapısından geçer.
 * `computer` ayrı durur çünkü onay kartında gösterilecek şey farklı: dosya
 * farkı ya da komut satırı değil, tarayıcıda yapılacak eylem.
 */
export type ToolRisk = "read" | "write" | "exec" | "computer";

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
  const source =
    tool.parametersOverride ??
    (z.toJSONSchema(tool.schema as z.ZodType, { io: "input" }) as Record<string, unknown>);
  const { $schema: _dropped, ...rest } = source;
  return stripLengthBounds(rest) as Record<string, unknown>;
}

/**
 * `minLength`/`maxLength` şemadan çıkarılır.
 *
 * llama.cpp araç şemasını bir GBNF dilbilgisine çevirir ve dizge uzunluk
 * sınırı orada bir yineleme kuralına dönüşür. Belirli değerlerde üretilen
 * dilbilgisi bozuk çıkıyor: `maxLength: 2000` istekin tamamını
 * "failed to parse grammar" ile 400'e düşürüyor (1999 ve 2001 sorunsuz).
 * Tek bir şanssız sayı bütün araç çağırmayı öldürüyordu.
 *
 * Kayıp yok: uzunluk bir doğrulama kuralıdır ve model cevap verdikten sonra
 * zod tarafından zaten uygulanıyor. Modele anlatılması gereken şey
 * açıklamada duruyor. Sayı aralıkları (`minimum`/`maximum`) sorun çıkarmıyor
 * ve modele gerçekten yol gösteriyor; onlar kalıyor.
 */
export function stripLengthBounds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLengthBounds);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "minLength" || key === "maxLength") continue;
    out[key] = stripLengthBounds(entry);
  }
  return out;
}

export function defineTool<Input>(tool: Tool<Input>): Tool<Input> {
  return tool;
}

/** Planlayıcının ürettiği alt görev. */
export interface PlanTask {
  id: string;
  title: string;
  /** Alt ajana verilecek istem. */
  prompt: string;
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
  | { type: "plan"; tasks: PlanTask[] }
  | { type: "task_start"; id: string; index: number; title: string }
  | { type: "task_end"; id: string; failed: boolean; summary: string; ms: number }
  | { type: "error"; message: string }
  | { type: "done"; reason: "stop" | "max_steps" | "aborted" | "error" };
