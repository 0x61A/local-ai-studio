import { getSystemInfo, getTelemetry } from "../hardware/detect.js";
import { APP_VERSION } from "../config.js";
import type { HealthStatus } from "@studio/shared";
import type { Router } from "../http/router.js";

export function registerSystemRoutes(router: Router): void {
  // Launcher'in "sunucu ayakta mi" yoklamasi. Veri tasimaz, token istemez.
  router.get("/api/ping", { public: true }, () => ({
    ok: true,
    version: APP_VERSION,
  }));

  router.get("/api/system", {}, () => getSystemInfo());

  router.get("/api/telemetry", {}, () => getTelemetry());

  router.get("/api/health", {}, (): HealthStatus => {
    // Faz 1'de motor supervisor'i gercek durumlari doldurur.
    return { ok: true, version: APP_VERSION, engines: {}, issues: [] };
  });
}
