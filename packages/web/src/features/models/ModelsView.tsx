import { useEffect, useState } from "react";
import { api, type HfFile, type HfModelSummary } from "../../lib/api";
import { formatGb } from "../../lib/format";
import { useModels } from "../../stores/models";
import { useUi } from "../../stores/ui";

export function ModelsView() {
  const t = useUi((s) => s.t);
  const {
    local,
    engine,
    downloads,
    busy,
    error,
    refresh,
    refreshDownloads,
    loadEngine,
    unloadEngine,
    deleteModel,
    cancelDownload,
  } = useModels();

  useEffect(() => {
    void refresh();
    void refreshDownloads();
    // İndirme sürerken ilerlemeyi göstermek için kısa aralıkla yokla.
    const timer = setInterval(() => void refreshDownloads(), 1000);
    return () => clearInterval(timer);
  }, [refresh, refreshDownloads]);

  const active = downloads.filter(
    (task) => task.state === "downloading" || task.state === "queued" || task.state === "verifying",
  );

  return (
    <div className="main__inner">
      <h1 className="page-title">{t("nav.models")}</h1>

      {error && <p className="chat__error" role="alert">{error}</p>}

      <section className="card">
        <h2 className="card__title">{t("models.engine")}</h2>
        {engine?.state === "ready" ? (
          <div className="facts">
            <Row label={t("models.loaded")} value={engine.model} />
            <Row label={t("models.context")} value={String(engine.plan?.contextSize ?? "?")} />
            <Row label={t("models.footprint")} value={formatGb(engine.footprintMb)} />
            <div className="facts__row">
              <span className="facts__label" />
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={() => void unloadEngine()}
              >
                {t("models.unload")}
              </button>
            </div>
          </div>
        ) : (
          <p className="facts__note">
            {engine?.state === "error" && engine.error
              ? engine.error
              : t("models.noEngine")}
          </p>
        )}
      </section>

      {active.length > 0 && (
        <section className="card">
          <h2 className="card__title">{t("models.downloads")}</h2>
          <div className="facts">
            {active.map((task) => {
              const percent = task.totalBytes
                ? Math.round((task.downloadedBytes / task.totalBytes) * 100)
                : 0;
              return (
                <div className="meter" key={task.id}>
                  <div className="meter__head">
                    <span>
                      {task.filename}
                      {task.resumed && ` · ${t("models.resumed")}`}
                    </span>
                    <span className="meter__value">
                      {task.state === "verifying"
                        ? t("models.verifying")
                        : `${percent}% · ${(task.bytesPerSecond / 1048576).toFixed(1)} MB/s`}
                    </span>
                  </div>
                  <div className="meter__track">
                    <div className="meter__fill" style={{ width: `${percent}%` }} />
                  </div>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => void cancelDownload(task.id)}
                  >
                    {t("models.cancel")}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="card__title">{t("models.local")}</h2>
        {local.length === 0 ? (
          <p className="facts__note">{t("models.noLocal")}</p>
        ) : (
          <ul className="model-list">
            {local.map((model) => (
              <li className="model" key={model.filename}>
                <div className="model__head">
                  <span className="model__name">{model.filename}</span>
                  <span className="model__size">{formatGb(model.sizeBytes / 1048576)}</span>
                </div>
                <p className="model__meta">
                  {model.error ? (
                    <span className="model__error">{model.error}</span>
                  ) : (
                    <>
                      {model.architecture} · {model.quantization} ·{" "}
                      {t("models.trainContext", { n: model.contextLength })}
                      <br />
                      <span className={model.fits ? "" : "model__error"}>
                        {model.planReason}
                      </span>
                    </>
                  )}
                </p>
                <div className="model__actions">
                  <button
                    type="button"
                    className="button button--small"
                    disabled={busy || !model.fits || engine?.model === model.filename}
                    onClick={() => void loadEngine(model.filename)}
                  >
                    {engine?.model === model.filename ? t("models.active") : t("models.load")}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => void deleteModel(model.filename)}
                  >
                    {t("models.delete")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <HuggingFaceSearch />
    </div>
  );
}

function HuggingFaceSearch() {
  const t = useUi((s) => s.t);
  const download = useModels((s) => s.download);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HfModelSummary[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<HfFile[]>([]);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setStatus(t("models.searching"));
    try {
      setResults(await api.hfSearch(query));
      setStatus(null);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  const expand = async (repo: string) => {
    if (expanded === repo) {
      setExpanded(null);
      return;
    }
    setExpanded(repo);
    setFiles([]);
    setStatus(t("models.loadingFiles"));
    try {
      const detail = await api.hfModel(repo);
      setFiles(detail.files);
      setRecommended(detail.recommended);
      setStatus(null);
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  return (
    <section className="card">
      <h2 className="card__title">{t("models.discover")}</h2>
      <form
        className="search-row"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          className="input"
          type="search"
          value={query}
          placeholder={t("models.searchPlaceholder")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="button">
          {t("models.search")}
        </button>
      </form>

      {status && <p className="facts__note">{status}</p>}

      <ul className="model-list">
        {results.map((result) => (
          <li className="model" key={result.id}>
            <button
              type="button"
              className="model__expand"
              onClick={() => void expand(result.id)}
              aria-expanded={expanded === result.id}
            >
              <span className="model__name">{result.id}</span>
              <span className="model__size">
                ↓ {result.downloads.toLocaleString("tr")}
              </span>
            </button>

            {expanded === result.id && files.length > 0 && (
              <ul className="file-list">
                {files.map((file) => (
                  <li className="file" key={file.path}>
                    <span className="file__name">
                      {file.path}
                      {file.path === recommended && (
                        <span className="file__badge">{t("models.recommended")}</span>
                      )}
                    </span>
                    <span className="file__size">
                      {formatGb(file.sizeBytes / 1048576)}
                    </span>
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() =>
                        void download(file.downloadUrl, file.path, file.sha256)
                      }
                    >
                      {t("models.download")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="facts__row">
      <span className="facts__label">{label}</span>
      <span className="facts__value">{value}</span>
    </div>
  );
}
