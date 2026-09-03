import { useEffect, useMemo, useState } from "react";
import { api, type CatalogCategory, type CatalogModel, type HfFile, type HfModelSummary } from "../../lib/api";
import { formatGb } from "../../lib/format";
import { useModels } from "../../stores/models";
import { useUi } from "../../stores/ui";

const CATEGORIES: Array<{ key: CatalogCategory | "all"; labelKey: string }> = [
  { key: "all", labelKey: "models.categoryAll" },
  { key: "popular", labelKey: "models.categoryPopular" },
  { key: "reasoning", labelKey: "models.categoryReasoning" },
  { key: "coding", labelKey: "models.categoryCoding" },
  { key: "lightweight", labelKey: "models.categoryLightweight" },
  { key: "large", labelKey: "models.categoryLarge" },
  { key: "vision", labelKey: "models.categoryVision" },
  { key: "embedding", labelKey: "models.categoryEmbedding" },
];

export function ModelsView() {
  const t = useUi((s) => s.t);
  const lang = useUi((s) => s.language);
  const {
    local,
    catalog,
    engine,
    downloads,
    busy,
    error,
    refresh,
    loadCatalog,
    refreshDownloads,
    loadEngine,
    unloadEngine,
    deleteModel,
    cancelDownload,
  } = useModels();

  useEffect(() => {
    void refresh();
    void refreshDownloads();
    void loadCatalog(lang);
    // İndirme sürerken ilerlemeyi göstermek için kısa aralıkla yokla.
    const timer = setInterval(() => void refreshDownloads(), 1000);
    return () => clearInterval(timer);
  }, [refresh, refreshDownloads, loadCatalog, lang]);

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
                  {model.projector && (
                    <span className="badge badge--success">{t("models.visionReady")}</span>
                  )}
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

      <CatalogSection catalog={catalog} />

      <CustomHuggingFaceSearch />
    </div>
  );
}

function CatalogSection({ catalog }: { catalog: CatalogModel[] }) {
  const t = useUi((s) => s.t);
  const [selectedCategory, setSelectedCategory] = useState<CatalogCategory | "all">("all");
  const [filterText, setFilterText] = useState("");

  const filtered = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return catalog.filter((item) => {
      if (selectedCategory !== "all" && item.category !== selectedCategory) {
        return false;
      }
      if (!query) return true;
      return (
        item.name.toLowerCase().includes(query) ||
        item.repo.toLowerCase().includes(query) ||
        item.parameters.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }, [catalog, selectedCategory, filterText]);

  return (
    <section className="card">
      <div className="catalog-header">
        <div>
          <h2 className="card__title">{t("models.catalogTitle")}</h2>
          <p className="facts__note">{t("models.catalogNote")}</p>
        </div>

        <div className="catalog-tabs" role="tablist">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.key}
              type="button"
              role="tab"
              aria-selected={selectedCategory === cat.key}
              className={`catalog-tab ${selectedCategory === cat.key ? "catalog-tab--active" : ""}`}
              onClick={() => setSelectedCategory(cat.key)}
            >
              {t(cat.labelKey as never)}
            </button>
          ))}
        </div>

        <input
          className="input input--compact"
          type="search"
          value={filterText}
          placeholder={t("models.filterPlaceholder")}
          onChange={(e) => setFilterText(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <p className="facts__note">{t("models.noCatalogMatch")}</p>
      ) : (
        <div className="catalog-grid">
          {filtered.map((item) => (
            <CatalogCard key={item.id} model={item} />
          ))}
        </div>
      )}
    </section>
  );
}

function CatalogCard({ model }: { model: CatalogModel }) {
  const t = useUi((s) => s.t);
  const { local, engine, downloads, busy, loadEngine, download, downloadCatalog } =
    useModels();
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState<HfFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // Dosya adi artik katalogda tutulmuyor; eslesme deponun son parcasi ve
  // model kimligi uzerinden yapilir.
  const stem = model.repo.split("/").pop()?.replace(/-gguf$/i, "").toLowerCase() ?? "";
  const belongsTo = (filename: string) => {
    const name = filename.toLowerCase();
    return (
      (stem.length > 3 && name.includes(stem)) ||
      name.includes(model.id.toLowerCase())
    );
  };

  const localMatch = local.find((l) => belongsTo(l.filename));

  const activeDownload = downloads.find(
    (d) =>
      belongsTo(d.filename) &&
      (d.state === "downloading" || d.state === "queued" || d.state === "verifying"),
  );

  const toggleFiles = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (files.length === 0) {
      setLoadingFiles(true);
      try {
        const detail = await api.hfModel(model.repo);
        setFiles(detail.files);
      } catch {
        // Hata durumunda boş liste kalır
      } finally {
        setLoadingFiles(false);
      }
    }
  };

  const isLoaded = localMatch && engine?.model === localMatch.filename;

  return (
    <div className="catalog-card">
      <div className="catalog-card__head">
        <div className="catalog-card__title">
          <span className="catalog-card__name">{model.name}</span>
          <span className="catalog-card__repo">{model.repo}</span>
        </div>
        <div className="catalog-card__badges">
          <span className="badge badge--accent">{model.parameters}</span>
          <span className="badge">~{formatGb(model.approxSizeBytes / 1048576)}</span>
        </div>
      </div>

      <p className="catalog-card__desc">{model.description}</p>

      <div className="catalog-card__tags">
        {model.tags.map((tag) => (
          <span key={tag} className="catalog-tag">
            {tag}
          </span>
        ))}
      </div>

      <div className="catalog-card__meta">
        <span>{t("models.contextWindow", { n: model.contextLength.toLocaleString("tr") })}</span>
        <span className={`catalog-card__compatibility ${model.fits ? "badge--success" : "badge--warning"}`}>
          {model.fits ? "✓ " : "⚠️ "}
          {model.fitsReason}
        </span>
      </div>

      {model.needsProjector && (
        <p className="facts__note">
          {localMatch && !localMatch.projector
            ? t("models.projectorMissing")
            : t("models.projectorIncludedShort")}
        </p>
      )}

      <div className="catalog-card__actions">
        {localMatch ? (
          <button
            type="button"
            className="button button--small"
            disabled={busy || isLoaded}
            onClick={() => void loadEngine(localMatch.filename)}
          >
            {isLoaded ? t("models.active") : t("models.load")}
          </button>
        ) : activeDownload ? (
          <span className="badge badge--accent">
            {t("models.downloading")}{" "}
            {activeDownload.totalBytes > 0
              ? `${Math.round((activeDownload.downloadedBytes / activeDownload.totalBytes) * 100)}%`
              : ""}
          </span>
        ) : (
          <button
            type="button"
            className="button button--small"
            onClick={() => void downloadCatalog(model.id)}
          >
            ↓ {t("models.quickDownload")}
          </button>
        )}

        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => void toggleFiles()}
        >
          {expanded ? t("models.hideFiles") : t("models.allFiles")}
        </button>
      </div>

      {expanded && (
        <div>
          {loadingFiles ? (
            <p className="facts__note">{t("models.loadingFiles")}</p>
          ) : files.length === 0 ? (
            <p className="facts__note">{t("models.noCatalogMatch")}</p>
          ) : (
            <ul className="file-list">
              {files.map((file) => {
                const isFileDownloaded = local.some((l) => l.filename === file.path);
                const isFileDownloading = downloads.some(
                  (d) =>
                    d.filename === file.path &&
                    (d.state === "downloading" || d.state === "queued" || d.state === "verifying"),
                );
                return (
                  <li className="file" key={file.path}>
                    <span className="file__name">
                      {file.path}
                      {file.path.toLowerCase().includes(model.preferredQuant.toLowerCase()) && (
                        <span className="file__badge">{t("models.recommendedBadge")}</span>
                      )}
                    </span>
                    <span className="file__size">{formatGb(file.sizeBytes / 1048576)}</span>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={isFileDownloaded || isFileDownloading}
                      onClick={() => void download(file.downloadUrl, file.path, file.sha256)}
                    >
                      {isFileDownloaded
                        ? t("models.downloaded")
                        : isFileDownloading
                          ? t("models.downloading")
                          : t("models.download")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function CustomHuggingFaceSearch() {
  const t = useUi((s) => s.t);
  const download = useModels((s) => s.download);
  const local = useModels((s) => s.local);
  const downloads = useModels((s) => s.downloads);
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
      <h2 className="card__title">{t("models.customSearchTitle")}</h2>
      <p className="facts__note">{t("models.customSearchNote")}</p>
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
                {files.map((file) => {
                  const isFileDownloaded = local.some((l) => l.filename === file.path);
                  const isFileDownloading = downloads.some(
                    (d) =>
                      d.filename === file.path &&
                      (d.state === "downloading" || d.state === "queued" || d.state === "verifying"),
                  );
                  return (
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
                        disabled={isFileDownloaded || isFileDownloading}
                        onClick={() =>
                          void download(file.downloadUrl, file.path, file.sha256)
                        }
                      >
                        {isFileDownloaded
                          ? t("models.downloaded")
                          : isFileDownloading
                            ? t("models.downloading")
                            : t("models.download")}
                      </button>
                    </li>
                  );
                })}
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
