import { spawn } from "node:child_process";
import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "../types.js";

/**
 * Komut çalıştırma.
 *
 * En riskli araç, bu yüzden en dar kapı:
 *  - Her çağrı onay ister ve onay kartında tam komut satırı görünür.
 *  - Çalışma dizini her zaman çalışma alanı kökü.
 *  - Zaman aşımı ve çıktı sınırı var; sonsuz süreç sunucuyu tutmaz.
 *  - Süreç kendi grubunda çalışır; zaman aşımında grubun tamamı öldürülür,
 *    yoksa `npm test &` gibi bir alt süreç arkada kalırdı.
 */

const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 20_000;

export const runCommand: Tool<{ command: string; timeoutSeconds?: number }> = defineTool({
  name: "run_command",
  description:
    "Çalışma alanı klasöründe bir kabuk komutu çalıştırır ve çıktısını döner. " +
    "Her çağrı kullanıcı onayı ister.",
  risk: "exec",
  schema: z.object({
    command: z.string().min(1).max(4000).describe("Çalıştırılacak kabuk komutu"),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("Zaman aşımı (saniye)"),
  }),
  async run(input, context): Promise<ToolResult> {
    const approved = await context.requestApproval({
      toolName: "run_command",
      risk: "exec",
      summary: `Komut çalıştır: ${firstLine(input.command)}`,
      command: input.command,
      arguments: { command: input.command, cwd: context.workspaceRoot },
    });
    if (!approved) {
      return { content: "Kullanıcı komut çalıştırmayı reddetti.", isError: true };
    }
    return execute(input.command, context, (input.timeoutSeconds ?? 120) * 1000);
  },
});

function execute(
  command: string,
  context: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd: context.workspaceRoot,
      // Kendi süreç grubunda: zaman aşımında alt süreçler de gider.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let truncated = false;
    const append = (chunk: string) => {
      if (output.length >= MAX_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk;
    };
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, Math.min(timeoutMs, TIMEOUT_MS));

    const onAbort = () => killGroup(child.pid);
    context.signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (err) => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      resolve({ content: `Komut başlatılamadı: ${err.message}`, isError: true });
    });

    child.once("close", (code, signal) => {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      const body = output.slice(0, MAX_OUTPUT_CHARS) + (truncated ? "\n… (çıktı kesildi)" : "");
      if (timedOut) {
        resolve({
          content: `Komut ${Math.round(timeoutMs / 1000)} saniyede bitmedi ve durduruldu.\n\n${body}`,
          isError: true,
        });
        return;
      }
      resolve({
        content:
          `Çıkış kodu: ${code ?? `sinyal ${signal}`}\n\n${body || "(çıktı yok)"}`,
        detail: { exitCode: code, signal, truncated },
        isError: code !== 0,
      });
    });
  });
}

/** Süreç grubunun tamamını öldürür; yalnızca kendi başlattığımız grubu. */
function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Süreç zaten bitmiş.
    }
  }
}

function firstLine(command: string): string {
  const line = command.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

export const shellTools = [runCommand];
