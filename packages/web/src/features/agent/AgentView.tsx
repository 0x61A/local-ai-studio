import { useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "../../stores/agent";
import { useModels } from "../../stores/models";
import { useUi } from "../../stores/ui";
import { PlanPanel } from "./PlanPanel";
import { Transcript } from "./Transcript";
import { WorkspaceBar } from "./WorkspaceBar";
import { ToolPanel } from "./ToolPanel";

export function AgentView() {
  const t = useUi((s) => s.t);
  const { status, entries, tasks, running, step, error, refresh, run, stop, reset } =
    useAgent();
  const { engine, providers, providerModels, refresh: refreshModels, loadProviderModels } =
    useModels();

  const [provider, setProvider] = useState("llamacpp");
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const [showTools, setShowTools] = useState(false);
  const [plan, setPlan] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refresh();
    void refreshModels();
  }, [refresh, refreshModels]);

  useEffect(() => {
    void loadProviderModels(provider);
  }, [provider, loadProviderModels]);

  const options = useMemo(() => {
    if (provider === "llamacpp") {
      return engine?.state === "ready" ? [{ id: engine.model, label: engine.model }] : [];
    }
    return (providerModels[provider] ?? []).map((m) => ({ id: m.id, label: m.label }));
  }, [provider, providerModels, engine]);

  useEffect(() => {
    if (options.length > 0 && !options.some((o) => o.id === model)) setModel(options[0]!.id);
  }, [options, model]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  const noWorkspace = !status?.workspace;
  const canRun = Boolean(model) && !noWorkspace && !running;

  return (
    <div className="agent">
      <WorkspaceBar />

      <div className="chat__bar">
        <label className="field field--inline">
          <span className="field__label">{t("chat.provider")}</span>
          <select
            className="input input--compact"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            disabled={running}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.hasKey}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--inline field--grow">
          <span className="field__label">{t("chat.model")}</span>
          <select
            className="input input--compact"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={options.length === 0 || running}
          >
            {options.length === 0 && <option value="">{t("chat.noModels")}</option>}
            {options.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>

        <label className="field field--check" title={t("agent.plan.hint")}>
          <input
            type="checkbox"
            checked={plan}
            disabled={running}
            onChange={(event) => setPlan(event.target.checked)}
          />
          <span>{t("agent.plan.toggle")}</span>
        </label>

        {running && <span className="agent__step">{t("agent.step", { n: step })}</span>}

        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setShowTools((value) => !value)}
          aria-expanded={showTools}
        >
          {t("agent.tools")}
        </button>
        {entries.length > 0 && !running && (
          <button type="button" className="button button--ghost button--small" onClick={reset}>
            {t("agent.clear")}
          </button>
        )}
      </div>

      {showTools && <ToolPanel />}
      <PlanPanel tasks={tasks} />

      <div className="chat__scroll">
        {noWorkspace && <p className="chat__empty">{t("agent.pickWorkspaceFirst")}</p>}
        {!noWorkspace && entries.length === 0 && (
          <p className="chat__empty">{t("agent.empty")}</p>
        )}
        <Transcript entries={entries} />
        {error && <p className="chat__error" role="alert">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = task.trim();
          if (!trimmed || !canRun) return;
          setTask("");
          void run(trimmed, { provider, model, plan });
        }}
      >
        <textarea
          className="composer__input"
          rows={2}
          value={task}
          disabled={running}
          placeholder={
            noWorkspace ? t("agent.pickWorkspaceFirst") : t("agent.placeholder")
          }
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {running ? (
          <button type="button" className="button button--ghost" onClick={() => void stop()}>
            {t("agent.stop")}
          </button>
        ) : (
          <button type="submit" className="button" disabled={!canRun || !task.trim()}>
            {t("agent.run")}
          </button>
        )}
      </form>
    </div>
  );
}
