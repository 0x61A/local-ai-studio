import { useAgent } from "../../stores/agent";
import { useUi } from "../../stores/ui";

export function ToolPanel() {
  const t = useUi((s) => s.t);
  const { tools, status, closeBrowser } = useAgent();

  return (
    <div className="tool-panel">
      <ul className="tool-panel__list">
        {tools.map((tool) => (
          <li className="tool-panel__item" key={tool.name}>
            <span className={`risk risk--${tool.risk}`}>{t(`agent.risk.${tool.risk}`)}</span>
            <code className="tool-panel__name">{tool.name}</code>
            <span className="tool-panel__desc">{tool.description}</span>
          </li>
        ))}
      </ul>
      {status && !status.browser.installed && (
        <p className="facts__note">{t("agent.browserMissing")}</p>
      )}
      {status?.browser.open && (
        <p className="facts__note">
          {t("agent.browserOpen")}{" "}
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void closeBrowser()}
          >
            {t("agent.browserClose")}
          </button>
        </p>
      )}
      {status && status.alwaysAllowed.length > 0 && (
        <p className="facts__note">
          {t("agent.alwaysAllowed")}: {status.alwaysAllowed.join(", ")}
        </p>
      )}
    </div>
  );
}
