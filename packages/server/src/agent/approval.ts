import crypto from "node:crypto";
import type { ApprovalRequest, ToolRisk } from "./types.js";

/**
 * Onay kapısı.
 *
 * Ajan döngüsü sunucuda çalışır, karar tarayıcıda verilir. Döngü bekleyen
 * bir söz üretir; istemci /api/agent/approve çağırınca söz çözülür.
 *
 * Varsayılan reddetmektir: zaman aşımı, oturum kapanması ya da sunucunun
 * yeniden başlaması hâlinde araç çalışmaz. "Cevap gelmedi" hiçbir zaman
 * "izin verildi" anlamına gelmez.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  createdAt: number;
}

interface Waiter {
  request: ApprovalRequest;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  createdAt: number;
}

export class ApprovalGate {
  private readonly waiting = new Map<string, Waiter>();
  /** Oturum boyunca "hep izin ver" denen araçlar. Diske yazılmaz. */
  private readonly alwaysAllow = new Set<string>();

  constructor(private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  /** `read` araçları buraya hiç uğramaz; çağıran taraf riski kontrol eder. */
  needsApproval(risk: ToolRisk, toolName: string): boolean {
    if (risk === "read") return false;
    return !this.alwaysAllow.has(toolName);
  }

  request(
    request: ApprovalRequest,
    onPending: (pending: PendingApproval) => void,
  ): Promise<boolean> {
    const id = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(false); // zaman aşımı = reddet
      }, this.timeoutMs);
      // Bekleyen kayıt süreç kapanışını engellemesin.
      timer.unref?.();

      this.waiting.set(id, { request, resolve, timer, createdAt: Date.now() });
      onPending({ id, request, createdAt: Date.now() });
    });
  }

  resolve(id: string, approved: boolean, always = false): boolean {
    const waiter = this.waiting.get(id);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiting.delete(id);
    if (approved && always) this.alwaysAllow.add(waiter.request.toolName);
    waiter.resolve(approved);
    return true;
  }

  /** Ajan durdurulduğunda bekleyen her şey reddedilir. */
  rejectAll(): void {
    for (const [id] of this.waiting) this.resolve(id, false);
  }

  list(): PendingApproval[] {
    return [...this.waiting.entries()].map(([id, waiter]) => ({
      id,
      request: waiter.request,
      createdAt: waiter.createdAt,
    }));
  }

  allowedAlways(): string[] {
    return [...this.alwaysAllow];
  }

  /** Sunucu yeniden başlamadan izinleri sıfırlamak için. */
  clearAlwaysAllow(): void {
    this.alwaysAllow.clear();
  }
}
