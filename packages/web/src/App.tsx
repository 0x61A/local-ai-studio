import { useEffect, useState } from "react";
import type { SystemInfo, Telemetry } from "@studio/shared";
import { ApiRequestError, api, hasToken } from "./lib/api";
import { useUi } from "./stores/ui";
import { Sidebar } from "./features/shell/Sidebar";
import { SystemPanel } from "./features/shell/SystemPanel";
import { TelemetryPanel } from "./features/shell/TelemetryPanel";
import { Notice } from "./features/shell/Notice";

const TELEMETRY_INTERVAL_MS = 2000;

export function App() {
  const t = useUi((s) => s.t);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [authError, setAuthError] = useState(!hasToken());

  useEffect(() => {
    if (authError) return;
    let cancelled = false;

    const load = async () => {
      try {
        const info = await api.system();
        if (!cancelled) setSystem(info);
      } catch (err) {
        if (!cancelled && err instanceof ApiRequestError && err.status === 401) {
          setAuthError(true);
        }
      }
    };
    void load();

    const poll = async () => {
      try {
        const data = await api.telemetry();
        if (!cancelled) setTelemetry(data);
      } catch {
        // Gecici hata: bir sonraki tur yeniden dener.
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), TELEMETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authError]);

  if (authError) {
    return (
      <Notice
        title={t(hasToken() ? "auth.expiredTitle" : "auth.missingTitle")}
        body={t(hasToken() ? "auth.expiredBody" : "auth.missingBody")}
      />
    );
  }

  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <div className="main__inner">
          <h1 className="page-title">{t("system.title")}</h1>
          <SystemPanel system={system} />
          <TelemetryPanel telemetry={telemetry} />
        </div>
      </main>
    </div>
  );
}
