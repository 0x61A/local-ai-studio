import { useEffect, useState } from "react";
import { api, type McpServer, type McpStatus } from "../../lib/api";
import { useUi } from "../../stores/ui";

/**
 * MCP sunucu yönetimi. Yeni sunucu eklemek bir komut satırı çalıştırmak
 * demektir, bu yüzden ekleme formu komutu olduğu gibi gösterir.
 */
export function McpPanel() {
  const t = useUi((s) => s.t);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [statuses, setStatuses] = useState<McpStatus[]>([]);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");

  const load = async () => {
    try {
      const result = await api.mcpServers();
      setServers(result.servers);
      setStatuses(result.statuses);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const submit = async () => {
    setError(null);
    const parts = command.trim().split(/\s+/);
    if (parts.length === 0 || !parts[0]) {
      setError(t("mcp.commandRequired"));
      return;
    }
    try {
      const result = await api.saveMcpServer({
        id: id.trim(),
        label: label.trim() || id.trim(),
        transport: "stdio",
        command: parts[0],
        args: parts.slice(1),
        enabled: true,
      });
      setServers(result.servers);
      setStatuses(result.statuses);
      setId("");
      setLabel("");
      setCommand("");
      setAdding(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const remove = async (serverId: string) => {
    const result = await api.deleteMcpServer(serverId);
    setServers(result.servers);
    setStatuses(result.statuses);
  };

  return (
    <section className="card">
      <h2 className="card__title">{t("mcp.title")}</h2>
      <p className="facts__note">{t("mcp.note")}</p>

      {servers.length > 0 && (
        <ul className="model-list">
          {servers.map((server) => {
            const status = statuses.find((entry) => entry.id === server.id);
            return (
              <li className="model" key={server.id}>
                <div className="model__head">
                  <span className="model__name">
                    {server.label}
                    <span
                      className={`mcp__dot ${status?.connected ? "mcp__dot--on" : "mcp__dot--off"}`}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="model__size">
                    {status?.connected
                      ? t("mcp.toolCount", { n: status.toolCount })
                      : t("mcp.disconnected")}
                  </span>
                </div>
                <p className="model__meta">
                  <code>{[server.command, ...(server.args ?? [])].join(" ")}</code>
                  {status?.error && <span className="model__error"><br />{status.error}</span>}
                </p>
                <div className="model__actions">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => void remove(server.id)}
                  >
                    {t("mcp.remove")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p className="chat__error" role="alert">{error}</p>}

      {adding ? (
        <form
          className="mcp__form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            className="input input--compact"
            value={id}
            placeholder={t("mcp.idPlaceholder")}
            onChange={(event) => setId(event.target.value)}
          />
          <input
            className="input input--compact"
            value={label}
            placeholder={t("mcp.labelPlaceholder")}
            onChange={(event) => setLabel(event.target.value)}
          />
          <input
            className="input input--compact"
            value={command}
            spellCheck={false}
            placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Projects"
            onChange={(event) => setCommand(event.target.value)}
          />
          <div className="model__actions">
            <button type="submit" className="button button--small" disabled={!id.trim() || !command.trim()}>
              {t("mcp.add")}
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setAdding(false)}
            >
              {t("mcp.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="button button--small" onClick={() => setAdding(true)}>
          {t("mcp.addServer")}
        </button>
      )}
    </section>
  );
}
