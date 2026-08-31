import { useEffect, useState } from "react";
import { useAgent } from "../../stores/agent";
import { useUi } from "../../stores/ui";

export function WorkspaceBar() {
  const t = useUi((s) => s.t);
  const { status, chooseWorkspace, clearWorkspace } = useAgent();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft(status?.workspace ?? "");
  }, [status?.workspace]);

  return (
    <div className="workspace">
      <form
        className="workspace__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void chooseWorkspace(draft.trim());
        }}
      >
        <span className="field__label">{t("agent.workspace")}</span>
        <input
          className="input input--compact"
          value={draft}
          spellCheck={false}
          placeholder="~/Projects/site"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="button button--small">
          {status?.workspace ? t("agent.change") : t("agent.choose")}
        </button>
        {status?.workspace && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void clearWorkspace()}
          >
            {t("agent.clearWorkspace")}
          </button>
        )}
      </form>
      <p className="workspace__note">{t("agent.workspaceNote")}</p>
    </div>
  );
}
