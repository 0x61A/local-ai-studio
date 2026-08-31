import { useEffect, useRef, useState } from "react";
import { formatGb } from "../../lib/format";
import { useKnowledge } from "../../stores/knowledge";
import { useUi } from "../../stores/ui";
import { SourceList } from "./SourceList";

/** Gömme üretebilen sağlayıcılar ve makul varsayılan modelleri. */
const EMBED_PROVIDERS: Array<{ id: string; label: string; defaultModel: string }> = [
  { id: "llamacpp", label: "Yerel (llama.cpp)", defaultModel: "yerel" },
  { id: "openai", label: "OpenAI", defaultModel: "text-embedding-3-small" },
  { id: "gemini", label: "Google Gemini", defaultModel: "text-embedding-004" },
];

export function KnowledgeView() {
  const t = useUi((s) => s.t);
  const {
    overview, activeId, documents, sources, searching, uploading, error,
    refresh, select, create, remove, upload, removeDocument, testSearch,
    loadEmbedding, unloadEmbedding, clearError,
  } = useKnowledge();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const collections = overview?.collections ?? [];
  const active = collections.find((collection) => collection.id === activeId) ?? null;
  const jobs = (overview?.jobs ?? []).filter(
    (job) => job.status !== "done" && job.status !== "error",
  );
  const failed = (overview?.jobs ?? []).filter((job) => job.status === "error");

  return (
    <div className="main__inner">
      <h1 className="page-title">{t("nav.knowledge")}</h1>

      {error && (
        <p className="chat__error" role="alert" onClick={clearError}>
          {error}
        </p>
      )}

      <EmbeddingCard />

      <section className="card">
        <h2 className="card__title">{t("knowledge.collections")}</h2>
        {collections.length > 0 ? (
          <div className="kb__tabs">
            {collections.map((collection) => (
              <button
                key={collection.id}
                type="button"
                className="kb__tab"
                aria-current={collection.id === activeId ? "true" : undefined}
                onClick={() => void select(collection.id)}
              >
                {collection.name}
                <span className="kb__count">{collection.chunkCount}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="facts__note">{t("knowledge.noCollections")}</p>
        )}
        <CreateCollection onCreate={create} />
        {active && (
          <div className="kb__meta">
            <span>
              {t("knowledge.embedModel")}: {active.embedProvider} / {active.embedModel}
              {active.dimensions > 0 && ` · ${active.dimensions}`}
            </span>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => {
                if (confirm(t("knowledge.confirmDeleteCollection", { name: active.name }))) {
                  void remove(active.id);
                }
              }}
            >
              {t("knowledge.deleteCollection")}
            </button>
          </div>
        )}
      </section>

      {active && (
        <>
          <section className="card">
            <h2 className="card__title">{t("knowledge.documents")}</h2>
            <Dropzone
              busy={uploading}
              accept={overview?.supportedExtensions ?? []}
              maxBytes={overview?.maxUploadBytes ?? 0}
              onFiles={(files) => {
                for (const file of files) void upload(file);
              }}
            />

            {jobs.map((job) => (
              <div className="meter" key={job.documentId}>
                <div className="meter__head">
                  <span>{job.name}</span>
                  <span className="meter__value">
                    {t(`knowledge.status.${job.status}`)}
                    {job.status === "embedding" && ` ${job.progress}%`}
                  </span>
                </div>
                <div className="meter__track">
                  <div className="meter__fill" style={{ width: `${job.progress}%` }} />
                </div>
              </div>
            ))}

            {failed.map((job) => (
              <p className="model__error" key={job.documentId}>
                {job.name}: {job.error}
              </p>
            ))}

            {documents.length > 0 ? (
              <ul className="file-list">
                {documents.map((document) => (
                  <li className="file file--doc" key={document.id}>
                    <span className="file__badge">{document.kind}</span>
                    <span className="file__name">
                      {document.name}
                      {document.status === "error" && (
                        <span className="model__error"> {document.error}</span>
                      )}
                    </span>
                    <span className="file__size">
                      {document.pageCount > 1 &&
                        `${t("knowledge.pages", { n: document.pageCount })} · `}
                      {t("knowledge.chunks", { n: document.chunkCount })}
                    </span>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => void removeDocument(document.id)}
                    >
                      {t("knowledge.remove")}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="facts__note">{t("knowledge.noDocuments")}</p>
            )}
          </section>

          <section className="card">
            <h2 className="card__title">{t("knowledge.test")}</h2>
            <p className="facts__note">{t("knowledge.testNote")}</p>
            <SearchBox busy={searching} onSearch={testSearch} />
            <SourceList sources={sources} />
          </section>
        </>
      )}
    </div>
  );
}

function EmbeddingCard() {
  const t = useUi((s) => s.t);
  const { overview, loadEmbedding, unloadEmbedding } = useKnowledge();
  const embedding = overview?.embedding;
  const models = overview?.localEmbeddingModels ?? [];

  return (
    <section className="card">
      <h2 className="card__title">{t("knowledge.embedEngine")}</h2>
      {embedding?.ready ? (
        <div className="facts">
          <div className="facts__row">
            <span className="facts__label">{t("knowledge.loadedEmbedModel")}</span>
            <span className="facts__value">{embedding.model}</span>
          </div>
          <div className="facts__row">
            <span className="facts__label">{t("models.footprint")}</span>
            <span className="facts__value">{formatGb(embedding.footprintMb)}</span>
          </div>
          <div className="facts__row">
            <span className="facts__label" />
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void unloadEmbedding()}
            >
              {t("models.unload")}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="facts__note">{t("knowledge.embedEngineNote")}</p>
          {embedding?.error && <p className="model__error">{embedding.error}</p>}
          {models.length ? (
            <ul className="file-list">
              {models.map((model) => (
                <li className="file" key={model.filename}>
                  <span className="file__name">{model.filename}</span>
                  <span className="file__size">{formatGb(model.estimatedMb)}</span>
                  <button
                    type="button"
                    className="button button--small"
                    disabled={embedding?.state === "starting"}
                    onClick={() => void loadEmbedding(model.filename)}
                  >
                    {embedding?.state === "starting"
                      ? t("knowledge.starting")
                      : t("models.load")}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="facts__note">{t("knowledge.noEmbedModels")}</p>
          )}
        </>
      )}
    </section>
  );
}

function CreateCollection({
  onCreate,
}: {
  onCreate: (name: string, provider: string, model: string) => Promise<void>;
}) {
  const t = useUi((s) => s.t);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("llamacpp");
  const [model, setModel] = useState("");
  const { overview } = useKnowledge();

  const descriptor = EMBED_PROVIDERS.find((entry) => entry.id === provider);
  const localModel = overview?.embedding.model ?? "";
  const effectiveModel =
    model.trim() ||
    (provider === "llamacpp" ? localModel || "yerel" : (descriptor?.defaultModel ?? ""));

  return (
    <form
      className="kb__form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        void onCreate(name.trim(), provider, effectiveModel);
        setName("");
        setModel("");
      }}
    >
      <label className="field field--grow">
        <span className="field__label">{t("knowledge.newName")}</span>
        <input
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("knowledge.newNamePlaceholder")}
        />
      </label>
      <label className="field">
        <span className="field__label">{t("knowledge.provider")}</span>
        <select
          className="input"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {EMBED_PROVIDERS.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t("knowledge.embedModel")}</span>
        <input
          className="input"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={effectiveModel}
        />
      </label>
      <button type="submit" className="button" disabled={!name.trim()}>
        {t("knowledge.create")}
      </button>
    </form>
  );
}

function Dropzone({
  busy,
  accept,
  maxBytes,
  onFiles,
}: {
  busy: string | null;
  accept: string[];
  maxBytes: number;
  onFiles: (files: File[]) => void;
}) {
  const t = useUi((s) => s.t);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={over ? "dropzone dropzone--over" : "dropzone"}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onFiles([...event.dataTransfer.files]);
      }}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept={accept.join(",")}
        hidden
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <p className="dropzone__text">
        {busy ? t("knowledge.uploading", { name: busy }) : t("knowledge.dropHere")}
      </p>
      <p className="dropzone__hint">
        {accept.join(" ")}
        {maxBytes > 0 && ` · ≤ ${Math.round(maxBytes / 1024 / 1024)} MB`}
      </p>
      <button
        type="button"
        className="button button--ghost"
        disabled={busy !== null}
        onClick={() => input.current?.click()}
      >
        {t("knowledge.choose")}
      </button>
    </div>
  );
}

function SearchBox({
  busy,
  onSearch,
}: {
  busy: boolean;
  onSearch: (query: string) => Promise<void>;
}) {
  const t = useUi((s) => s.t);
  const [query, setQuery] = useState("");

  return (
    <form
      className="search-row"
      onSubmit={(event) => {
        event.preventDefault();
        void onSearch(query);
      }}
    >
      <input
        className="input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("knowledge.searchPlaceholder")}
      />
      <button type="submit" className="button" disabled={busy || !query.trim()}>
        {busy ? t("models.searching") : t("knowledge.search")}
      </button>
    </form>
  );
}
