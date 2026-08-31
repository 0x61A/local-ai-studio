import { getSystemInfo, getTelemetry } from "../hardware/detect.js";
import { getBudget, reservedMb } from "../hardware/budget.js";
import { llamaEngine } from "../engines/llama.js";
import { APP_VERSION } from "../config.js";
import { llamaBinary } from "../engines/llama.js";
import type { HealthStatus } from "@studio/shared";
import type { Router } from "../http/router.js";

export function registerSystemRoutes(router: Router): void {
  // Launcher'ın "sunucu ayakta mı" yoklaması. Veri taşımaz, token istemez.
  router.get("/api/ping", { public: true }, () => ({
    ok: true,
    version: APP_VERSION,
  }));

  router.get("/api/system", {}, () => getSystemInfo());

  router.get("/api/telemetry", {}, () => {
    const telemetry = getTelemetry();
    return {
      ...telemetry,
      // Motorların gerçekten ayırdığı bellek; işletim sistemi sayacından
      // ayrı tutulur çünkü bütçe kararları buna göre verilir.
      vramUsedMb: reservedMb(),
    };
  });

  router.get("/api/health", {}, (): HealthStatus => {
    const engine = llamaEngine.status();
    const issues: HealthStatus["issues"] = [];

    if (!llamaBinary()) {
      issues.push({
        code: "llama_missing",
        message:
          "llama.cpp motoru kurulu değil. `bash scripts/setup/fetch-llama.sh` çalıştırın.",
      });
    }
    if (engine.state === "error" && engine.error) {
      issues.push({ code: "engine_error", message: engine.error });
    }
    const budget = getBudget();
    if (budget.budgetMb < 2048) {
      issues.push({
        code: "low_memory",
        message: `Model yerleştirme için yalnızca ${budget.budgetMb} MB boş. Bazı uygulamaları kapatın.`,
      });
    }

    return {
      ok: issues.length === 0,
      version: APP_VERSION,
      engines: { llama: engine.state },
      issues,
    };
  });
}
