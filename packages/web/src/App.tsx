import { useEffect, useState } from "react";
import type { SystemInfo, Telemetry } from "@studio/shared";
import { ApiRequestError, api, hasToken } from "./lib/api";
import { useUi } from "./stores/ui";
import { Sidebar, type TabId } from "./features/shell/Sidebar";
import { SystemPanel } from "./features/shell/SystemPanel";
import { TelemetryPanel } from "./features/shell/TelemetryPanel";
import { Notice } from "./features/shell/Notice";
import { AgentView } from "./features/agent/AgentView";
import { ChatView } from "./features/chat/ChatView";
import { ModelsView } from "./features/models/ModelsView";
import { SettingsView } from "./features/settings/SettingsView";

const TELEMETRY_INTERVAL_MS = 2000;

export function App() {
  const t = useUi((s) => s.t);
  const [tab, setTab] = useState<TabId>("chat");
  const [authError, setAuthError] = useState(!hasToken());

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
      <Sidebar active={tab} onSelect={setTab} />
      <main className={tab === "chat" || tab === "agent" ? "main main--flush" : "main"}>
        {tab === "chat" && <ChatView />}
        {tab === "agent" && <AgentView />}
        {tab === "models" && <ModelsView />}
        {tab === "settings" && <SettingsView />}
        {tab === "system" && <SystemTab onAuthError={() => setAuthError(true)} />}
      </main>
    </div>
  );
}

function SystemTab({ onAuthError }: { onAuthError: () => void }) {
  const t = useUi((s) => s.t);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);

  useEffect(() => {
    let cancelled = false;

    void api
      .system()
      .then((info) => {
        if (!cancelled) setSystem(info);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiRequestError && err.status === 401) onAuthError();
      });

    const poll = () =>
      void api
        .telemetry()
        .then((data) => {
          if (!cancelled) setTelemetry(data);
        })
        .catch(() => {
          // Geçici hata: bir sonraki tur yeniden dener.
        });
    poll();
    const timer = setInterval(poll, TELEMETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onAuthError]);

  return (
    <div className="main__inner">
      <h1 className="page-title">{t("system.title")}</h1>
      <SystemPanel system={system} />
      <TelemetryPanel telemetry={telemetry} />
    </div>
  );
}
