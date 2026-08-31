import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { ENGINE_PID_FILE } from "../config.js";

/**
 * Motor süreç yöneticisi.
 *
 * Referans projede spawn / port bulma / hazırlık yoklaması / çıkış kodu
 * teşhisi her motor için ayrı ayrı yazılmıştı (~600 satır tekrar). Burada
 * tek sözleşme var; motorlar yalnızca kendi ikili dosyalarını ve
 * argümanlarını bildirir.
 *
 * Önemli: yalnızca kendi başlattığımız PID'i öldürürüz. Referans projedeki
 * `lsof -t -i:8080 | xargs kill -9` kullanıcının kendi servisini de
 * öldürüyordu.
 */

export type EngineState = "stopped" | "starting" | "ready" | "error";

export interface EngineStatus {
  id: string;
  state: EngineState;
  model: string;
  port: number | null;
  error: string | null;
  /** Kabaca ne kadar bellek tuttuğu; bütçe yöneticisi bunu kullanır. */
  footprintMb: number;
  startedAt: number | null;
}

export interface EngineSpec {
  /** Çalıştırılacak ikili dosyanın tam yolu. */
  binary: string;
  /** Seçilen porta göre argümanlar. */
  args: (port: number) => string[];
  env?: Record<string, string>;
  /** Kullanıcıya gösterilecek model adı. */
  model: string;
  footprintMb: number;
  /** Hazırlık yoklaması. true dönene kadar beklenir. */
  probe: (port: number) => Promise<boolean>;
  /** Yükleme ilerlemesini çıktı satırlarından okumak için. */
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  preferredPort: number;
  /** Hazır olma beklemesi. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 300_000; // büyük modeller diskten yavaş yüklenir
const PROBE_INTERVAL_MS = 400;
const LOG_TAIL_LINES = 40;

export class Engine {
  private child: ChildProcess | null = null;
  private state: EngineState = "stopped";
  private port: number | null = null;
  private error: string | null = null;
  private model = "";
  private footprintMb = 0;
  private startedAt: number | null = null;
  private readonly logTail: string[] = [];
  /** Başlat/durdur işlemleri sıraya alınır; eşzamanlı çağrı yarışmaz. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly id: string) {}

  status(): EngineStatus {
    return {
      id: this.id,
      state: this.state,
      model: this.model,
      port: this.port,
      error: this.error,
      footprintMb: this.footprintMb,
      startedAt: this.startedAt,
    };
  }

  /** Akış analizini kırmadan güncel durumu okur. */
  private currentState(): EngineState {
    return this.state;
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  baseUrl(): string | null {
    return this.state === "ready" && this.port
      ? `http://127.0.0.1:${this.port}`
      : null;
  }

  /** Son çıktı satırları -- hata teşhisi için. */
  recentLogs(): string[] {
    return [...this.logTail];
  }

  start(spec: EngineSpec): Promise<EngineStatus> {
    return this.enqueue(() => this.doStart(spec));
  }

  stop(): Promise<EngineStatus> {
    return this.enqueue(() => this.doStop());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doStart(spec: EngineSpec): Promise<EngineStatus> {
    if (this.isRunning()) await this.doStop();

    this.state = "starting";
    this.error = null;
    this.model = spec.model;
    this.footprintMb = spec.footprintMb;
    this.logTail.length = 0;

    const port = await findFreePort(spec.preferredPort);
    this.port = port;

    const child = spawn(spec.binary, spec.args(port), {
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    this.startedAt = Date.now();
    // Sunucu çökerse süreç sahipsiz kalır ve belleği tutmaya devam eder.
    // Kimliği diske yazıyoruz; sonraki açılışta reapOrphans() topluyor.
    recordPid(this.id, child.pid, spec.binary);

    captureOutput(child, (line, stream) => {
      this.logTail.push(line);
      if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
      spec.onLine?.(line, stream);
    });

    // Kutu içinde tutuluyor: TypeScript'in akış analizi zaman uyumsuz geri
    // çağrıdaki atamayı göremez ve düz değişkeni `never`e daraltır.
    const exit: {
      value: { code: number | null; signal: NodeJS.Signals | null } | null;
    } = { value: null };

    child.once("exit", (code, signal) => {
      exit.value = { code, signal };
      if (this.child === child) {
        this.child = null;
        if (this.state !== "stopped") {
          this.state = "error";
          this.error =
            this.error ?? describeExit(spec.binary, code, signal, this.logTail);
        }
      }
    });
    child.once("error", (err) => {
      this.state = "error";
      this.error = `Motor başlatılamadı (${spec.binary}): ${err.message}`;
    });

    const deadline = Date.now() + (spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      const exited = exit.value;
      if (exited) {
        this.state = "error";
        this.error =
          this.error ??
          describeExit(spec.binary, exited.code, exited.signal, this.logTail);
        this.port = null;
        return this.status();
      }
      // `error` durumuna "error" olayı geri çağrısından geçilmiş olabilir.
      if (this.currentState() === "error") {
        await this.doStop();
        this.state = "error";
        return this.status();
      }
      if (await spec.probe(port)) {
        this.state = "ready";
        return this.status();
      }
      await delay(PROBE_INTERVAL_MS);
    }

    this.error = `Motor ${Math.round((spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 1000)} saniyede hazır olmadı.`;
    await this.doStop();
    this.state = "error";
    return this.status();
  }

  private async doStop(): Promise<EngineStatus> {
    const child = this.child;
    this.state = "stopped";
    this.port = null;
    this.startedAt = null;
    this.footprintMb = 0;

    if (!child || child.exitCode !== null) {
      this.child = null;
      return this.status();
    }

    // Yalnızca kendi süreç kimliğimizi hedefleriz.
    await terminate(child);
    this.child = null;
    forgetPid(this.id);
    return this.status();
  }
}

// -- Yetim süreç toplama ------------------------------------------------------

interface PidRecord {
  pid: number;
  binary: string;
}

function readPidFile(): Record<string, PidRecord> {
  try {
    return JSON.parse(fs.readFileSync(ENGINE_PID_FILE, "utf8")) as Record<string, PidRecord>;
  } catch {
    return {};
  }
}

function writePidFile(records: Record<string, PidRecord>): void {
  try {
    fs.writeFileSync(ENGINE_PID_FILE, JSON.stringify(records), "utf8");
  } catch {
    // Kayıt tutulamazsa yetim toplama çalışmaz; çalışmayı engellemez.
  }
}

function recordPid(id: string, pid: number | undefined, binary: string): void {
  if (!pid) return;
  writePidFile({ ...readPidFile(), [id]: { pid, binary } });
}

function forgetPid(id: string): void {
  const records = readPidFile();
  delete records[id];
  writePidFile(records);
}

/**
 * Önceki oturumdan kalan motor süreçlerini toplar.
 *
 * Yalnızca BİZİM başlattığımız ikili dosyayı çalıştıran süreçler öldürülür:
 * kimlik geri kullanılmış olabilir, o yüzden öldürmeden önce komut satırı
 * kontrol edilir. Referans projedeki `taskkill /F /IM node.exe` gibi kör bir
 * öldürme burada asla yapılmaz.
 */
export function reapOrphans(): number {
  const records = readPidFile();
  let reaped = 0;

  for (const [id, record] of Object.entries(records)) {
    if (!isOurProcess(record.pid, record.binary)) {
      delete records[id];
      continue;
    }
    try {
      process.kill(record.pid, "SIGTERM");
      reaped += 1;
      console.log(`  [motor] önceki oturumdan kalan süreç kapatıldı (pid ${record.pid})`);
    } catch {
      // Süreç zaten yok.
    }
    delete records[id];
  }

  writePidFile(records);
  return reaped;
}

/** Kimlik gerçekten bizim ikili dosyamızı mı çalıştırıyor? */
function isOurProcess(pid: number, binary: string): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return command.includes(binary);
  } catch {
    return false;
  }
}

// -- Yardımcılar --------------------------------------------------------------

/** Önce SIGTERM, kapanmazsa SIGKILL. */
export async function terminate(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, graceMs);
  await exited;
  clearTimeout(timer);
}

function captureOutput(
  child: ChildProcess,
  onLine: (line: string, stream: "stdout" | "stderr") => void,
): void {
  for (const stream of ["stdout", "stderr"] as const) {
    const source = child[stream];
    if (!source) continue;
    let buffer = "";
    source.setEncoding("utf8");
    source.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed) onLine(trimmed, stream);
      }
    });
  }
}

/**
 * Çıkış kodunu anlaşılır hataya çevirir. Ham "exit 127" kullanıcıya
 * hiçbir şey söylemez; hangi durumun ne anlama geldiğini burada yazarız.
 */
export function describeExit(
  binary: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  logTail: string[] = [],
): string {
  const hint = (() => {
    if (signal === "SIGKILL") return "Süreç zorla sonlandırıldı (bellek yetersizliği olabilir).";
    if (code === 127) return "İkili dosya bulunamadı veya bağımlı kütüphane eksik.";
    if (code === 126) return "İkili dosya çalıştırılabilir değil (chmod +x gerekebilir).";
    if (code === 1) return "Motor hata ile çıktı; model dosyası bozuk veya uyumsuz olabilir.";
    if (code === 139 || signal === "SIGSEGV") return "Bellek erişim hatası; model mimarisi bu motorla uyumsuz olabilir.";
    return "Motor beklenmedik biçimde kapandı.";
  })();

  const relevant = logTail
    .filter((line) => /error|failed|cannot|unable|no such/i.test(line))
    .slice(-3);

  const detail = relevant.length ? `\n${relevant.join("\n")}` : "";
  return `${hint} (${binary.split("/").pop()}, kod ${code ?? "yok"}${signal ? `, sinyal ${signal}` : ""})${detail}`;
}

export async function findFreePort(preferred: number, attempts = 50): Promise<number> {
  for (let port = preferred; port < preferred + attempts; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`Motor için boş port bulunamadı (${preferred}+${attempts}).`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => tester.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** HTTP ucu 200 dönüyor mu -- motorların çoğu için yeterli yoklama. */
export async function httpProbe(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
