import { fileTools } from "./tools/files.js";
import { knowledgeTools } from "./tools/knowledge.js";
import { shellTools } from "./tools/shell.js";
import { webTools } from "./tools/web.js";
import { toolParameters, type Tool } from "./types.js";
import type { ToolDefinition } from "../providers/types.js";

/**
 * Araç kayıt defteri.
 *
 * Yerleşik araçlar burada toplanır; MCP sunucularından gelenler çalışma
 * anında eklenir (bkz. agent/mcp.ts). Ad çakışmasında MCP aracı `mcp__`
 * öneki taşıdığı için yerleşiklerle karışmaz.
 */

const builtin: Tool<never>[] = [
  ...(fileTools as Tool<never>[]),
  ...(webTools as Tool<never>[]),
  ...(knowledgeTools as Tool<never>[]),
  ...(shellTools as Tool<never>[]),
];

export function builtinTools(): Tool<never>[] {
  return [...builtin];
}

export function findTool(tools: Tool<never>[], name: string): Tool<never> | null {
  return tools.find((tool) => tool.name === name) ?? null;
}

/** Sağlayıcıya gönderilecek araç tanımları. */
export function toProviderTools(tools: Tool<never>[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toolParameters(tool),
  }));
}

export function describeTools(tools: Tool<never>[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    risk: tool.risk,
    parameters: toolParameters(tool),
  }));
}
