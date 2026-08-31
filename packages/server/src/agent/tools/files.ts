import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PathEscapeError, resolveInside } from "../../security/paths.js";
import { newFileDiff, unifiedDiff } from "../diff.js";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "../types.js";

/**
 * Dosya araçları.
 *
 * Hepsi çalışma alanı köküne kilitlidir: her yol resolveInside()'dan geçer,
 * sembolik bağ dahil dışarı çıkan istek hata döner. Yazma ve silme onay
 * kapısından geçer ve onay kartında fark önizlemesi gösterilir.
 */

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 500;

/** Çalışma alanında listelenmesi/okunması anlamsız olan dizinler. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  ".venv", "venv", ".cache", "target", "vendor",
]);

function inside(context: ToolContext, relative: string): string {
  try {
    return resolveInside(context.workspaceRoot, relative);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      throw new Error(
        `Yol çalışma alanının dışında: ${relative}. Ajan yalnızca seçilen klasörde çalışabilir.`,
      );
    }
    throw err;
  }
}

function relative(context: ToolContext, absolute: string): string {
  return path.relative(context.workspaceRoot, absolute) || ".";
}

export const readFile: Tool<{ path: string; maxBytes?: number }> = defineTool({
  name: "read_file",
  description:
    "Çalışma alanındaki bir metin dosyasını okur. Yol, çalışma alanı köküne görelidir.",
  risk: "read",
  schema: z.object({
    path: z.string().min(1).describe("Çalışma alanına göre dosya yolu"),
    maxBytes: z.number().int().min(1).max(MAX_READ_BYTES).optional()
      .describe("Okunacak en fazla bayt"),
  }),
  async run(input, context): Promise<ToolResult> {
    const target = inside(context, input.path);
    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return { content: `Dosya bulunamadı: ${input.path}`, isError: true };
    if (stats.isDirectory()) {
      return { content: `${input.path} bir klasör. list_dir kullanın.`, isError: true };
    }

    const limit = Math.min(input.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES);
    const handle = await fsp.open(target, "r");
    try {
      const buffer = Buffer.alloc(Math.min(limit, stats.size));
      await handle.read(buffer, 0, buffer.length, 0);
      // İkili dosyayı modele akıtmanın anlamı yok; null bayt kontrolü yeterli.
      if (buffer.includes(0)) {
        return {
          content: `${input.path} ikili bir dosya (${stats.size} bayt), metin olarak okunamaz.`,
          isError: true,
        };
      }
      const truncated = stats.size > buffer.length;
      return {
        content:
          buffer.toString("utf8") +
          (truncated ? `\n… (${stats.size - buffer.length} bayt daha kesildi)` : ""),
        detail: { path: relative(context, target), sizeBytes: stats.size, truncated },
      };
    } finally {
      await handle.close();
    }
  },
});

export const listDir: Tool<{ path?: string }> = defineTool({
  name: "list_dir",
  description: "Çalışma alanındaki bir klasörün içeriğini listeler.",
  risk: "read",
  schema: z.object({
    path: z.string().optional().describe("Klasör yolu; boş bırakılırsa kök"),
  }),
  async run(input, context): Promise<ToolResult> {
    const target = inside(context, input.path ?? ".");
    const entries = await fsp.readdir(target, { withFileTypes: true }).catch(() => null);
    if (!entries) return { content: `Klasör bulunamadı: ${input.path ?? "."}`, isError: true };

    const lines = entries
      .filter((entry) => !entry.name.startsWith("."))
      .slice(0, MAX_ENTRIES)
      .map((entry) => {
        if (entry.isDirectory()) return `${entry.name}/`;
        const size = safeSize(path.join(target, entry.name));
        return `${entry.name}  (${size} bayt)`;
      })
      .sort();

    return {
      content: lines.length ? lines.join("\n") : "(boş klasör)",
      detail: { path: relative(context, target), count: lines.length },
    };
  },
});

export const searchFiles: Tool<{ query: string; extension?: string }> = defineTool({
  name: "search_files",
  description:
    "Çalışma alanındaki metin dosyalarında bir dizge arar ve eşleşen satırları döner.",
  risk: "read",
  schema: z.object({
    query: z.string().min(1).describe("Aranacak metin (düz dizge, düzenli ifade değil)"),
    extension: z.string().max(10).optional().describe("Örnek: .ts"),
  }),
  async run(input, context): Promise<ToolResult> {
    const hits: string[] = [];
    const needle = input.query.toLowerCase();

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || hits.length >= 100 || context.signal.aborted) return;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (input.extension && !entry.name.endsWith(input.extension)) continue;
        const stats = await fsp.stat(full).catch(() => null);
        if (!stats || stats.size > MAX_READ_BYTES) continue;
        const text = await fsp.readFile(full, "utf8").catch(() => null);
        if (text === null) continue;
        text.split("\n").forEach((line, index) => {
          if (hits.length < 100 && line.toLowerCase().includes(needle)) {
            hits.push(`${relative(context, full)}:${index + 1}: ${line.trim().slice(0, 200)}`);
          }
        });
      }
    };

    await walk(inside(context, "."), 0);
    return {
      content: hits.length ? hits.join("\n") : `"${input.query}" için eşleşme yok.`,
      detail: { matches: hits.length },
    };
  },
});

export const writeFile: Tool<{ path: string; content: string }> = defineTool({
  name: "write_file",
  description:
    "Çalışma alanına dosya yazar veya var olanın üzerine yazar. Kullanıcı onayı ister.",
  risk: "write",
  schema: z.object({
    path: z.string().min(1).describe("Çalışma alanına göre dosya yolu"),
    content: z.string().max(MAX_WRITE_BYTES).describe("Dosyanın tam yeni içeriği"),
  }),
  async run(input, context): Promise<ToolResult> {
    const target = inside(context, input.path);
    const shown = relative(context, target);
    const existing = fs.existsSync(target)
      ? await fsp.readFile(target, "utf8").catch(() => null)
      : null;

    const approved = await context.requestApproval({
      toolName: "write_file",
      risk: "write",
      summary:
        existing === null
          ? `Yeni dosya oluştur: ${shown}`
          : `Dosyanın üzerine yaz: ${shown}`,
      diff:
        existing === null
          ? newFileDiff(input.content, shown)
          : unifiedDiff(existing, input.content, shown),
      arguments: { path: shown },
    });
    if (!approved) return { content: "Kullanıcı yazma işlemini reddetti.", isError: true };

    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, input.content, "utf8");
    return {
      content: `Yazıldı: ${shown} (${Buffer.byteLength(input.content)} bayt)`,
      detail: { path: shown, created: existing === null },
    };
  },
});

export const deleteFile: Tool<{ path: string }> = defineTool({
  name: "delete_file",
  description: "Çalışma alanındaki bir dosyayı siler. Kullanıcı onayı ister.",
  risk: "write",
  schema: z.object({ path: z.string().min(1).describe("Silinecek dosya yolu") }),
  async run(input, context): Promise<ToolResult> {
    const target = inside(context, input.path);
    const shown = relative(context, target);
    const stats = await fsp.stat(target).catch(() => null);
    if (!stats) return { content: `Dosya bulunamadı: ${shown}`, isError: true };
    if (stats.isDirectory()) {
      // Klasör silmeyi hiç açmıyoruz: geri alınamaz ve tek yanlış yolla
      // çalışma alanının tamamı gidebilir.
      return { content: "Klasör silme desteklenmiyor.", isError: true };
    }

    const approved = await context.requestApproval({
      toolName: "delete_file",
      risk: "write",
      summary: `Dosyayı sil: ${shown} (${stats.size} bayt)`,
      arguments: { path: shown },
    });
    if (!approved) return { content: "Kullanıcı silme işlemini reddetti.", isError: true };

    await fsp.rm(target);
    return { content: `Silindi: ${shown}` };
  },
});

function safeSize(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}

export const fileTools = [readFile, listDir, searchFiles, writeFile, deleteFile];
