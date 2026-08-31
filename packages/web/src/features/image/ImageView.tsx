import { useEffect, useState } from "react";
import { formatGb } from "../../lib/format";
import type { GenerateImageRequest, StoredImage } from "../../lib/api";
import { useImages } from "../../stores/images";
import { useUi } from "../../stores/ui";
import { GalleryImage } from "./GalleryImage";

const SIZES = [512, 640, 768, 896, 1024];

export function ImageView() {
  const t = useUi((s) => s.t);
  const {
    overview, gallery, selected, error, busy,
    refresh, loadGallery, clearError, select,
  } = useImages();

  useEffect(() => {
    void refresh();
    void loadGallery();
  }, [refresh, loadGallery]);

  const engine = overview?.engine;

  return (
    <div className="main__inner">
      <h1 className="page-title">{t("nav.image")}</h1>

      {error && (
        <p className="chat__error" role="alert" onClick={clearError}>
          {error}
        </p>
      )}

      <EngineCard />

      {engine?.ready && <PromptForm />}
      {engine?.ready && <JobList />}

      <section className="card">
        <div className="gallery__bar">
          <h2 className="card__title">{t("image.gallery")}</h2>
          <GalleryFilters />
        </div>
        {gallery.length ? (
          <div className="gallery">
            {gallery.map((image) => (
              <button
                type="button"
                key={image.id}
                className="gallery__item"
                onClick={() => select(image)}
                title={image.prompt}
              >
                <GalleryImage filename={image.filename} alt={image.prompt} />
                {image.favorite && <span className="gallery__star">★</span>}
              </button>
            ))}
          </div>
        ) : (
          <p className="facts__note">{t("image.emptyGallery")}</p>
        )}
      </section>

      {selected && <Detail image={selected} busy={busy} />}
    </div>
  );
}

function EngineCard() {
  const t = useUi((s) => s.t);
  const { overview, busy, loadEngine, unloadEngine } = useImages();
  const engine = overview?.engine;

  if (engine?.ready) {
    return (
      <section className="card">
        <h2 className="card__title">{t("image.engine")}</h2>
        <div className="facts">
          <div className="facts__row">
            <span className="facts__label">{t("models.loaded")}</span>
            <span className="facts__value">{engine.model}</span>
          </div>
          <div className="facts__row">
            <span className="facts__label">{t("models.footprint")}</span>
            <span className="facts__value">{formatGb(engine.footprintMb)}</span>
          </div>
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
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">{t("image.engine")}</h2>
      {engine?.error && <p className="model__error">{engine.error}</p>}
      {overview?.models.length ? (
        <ul className="file-list">
          {overview.models.map((model) => (
            <li className="file" key={model.filename}>
              <span className="file__name">{model.filename}</span>
              <span className="file__size">{formatGb(model.sizeBytes / 1048576)}</span>
              <button
                type="button"
                className="button button--small"
                disabled={busy || engine?.state === "starting"}
                onClick={() => void loadEngine(model.filename)}
              >
                {engine?.state === "starting" ? t("image.starting") : t("models.load")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="facts__note">
          {t("image.noModels", { dir: overview?.modelsDir ?? "" })}
        </p>
      )}
    </section>
  );
}

function PromptForm() {
  const t = useUi((s) => s.t);
  const { overview, selected, generate } = useImages();
  const capabilities = overview?.capabilities;

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [width, setWidth] = useState(512);
  const [height, setHeight] = useState(512);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(7);
  const [seed, setSeed] = useState(-1);
  const [batch, setBatch] = useState(1);
  const [sampler, setSampler] = useState("");
  const [hires, setHires] = useState(false);
  const [useInit, setUseInit] = useState(false);
  const [strength, setStrength] = useState(0.6);

  const submit = () => {
    if (!prompt.trim()) return;
    const request: GenerateImageRequest = {
      prompt: prompt.trim(),
      negativePrompt: negative.trim(),
      width,
      height,
      steps,
      cfgScale: cfg,
      seed,
      batchCount: batch,
      ...(sampler ? { sampler } : {}),
      ...(hires ? { hires: { enabled: true, scale: 2 } } : {}),
      ...(useInit && selected ? { initImageId: selected.id, strength } : {}),
    };
    void generate(request);
  };

  return (
    <section className="card">
      <h2 className="card__title">{t("image.generate")}</h2>

      <label className="field">
        <span className="field__label">{t("image.prompt")}</span>
        <textarea
          className="input composer__input"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("image.promptPlaceholder")}
        />
      </label>

      <label className="field">
        <span className="field__label">{t("image.negative")}</span>
        <input
          className="input"
          value={negative}
          onChange={(event) => setNegative(event.target.value)}
          placeholder={t("image.negativePlaceholder")}
        />
      </label>

      <div className="grid-form">
        <label className="field">
          <span className="field__label">{t("image.width")}</span>
          <select
            className="input"
            value={width}
            onChange={(event) => setWidth(Number(event.target.value))}
          >
            {SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t("image.height")}</span>
          <select
            className="input"
            value={height}
            onChange={(event) => setHeight(Number(event.target.value))}
          >
            {SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t("image.steps")}</span>
          <input
            className="input"
            type="number"
            min={1}
            max={150}
            value={steps}
            onChange={(event) => setSteps(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">{t("image.cfg")}</span>
          <input
            className="input"
            type="number"
            min={0}
            max={30}
            step={0.5}
            value={cfg}
            onChange={(event) => setCfg(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">{t("image.seed")}</span>
          <input
            className="input"
            type="number"
            min={-1}
            value={seed}
            onChange={(event) => setSeed(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">{t("image.batch")}</span>
          <input
            className="input"
            type="number"
            min={1}
            max={8}
            value={batch}
            onChange={(event) => setBatch(Number(event.target.value))}
          />
        </label>
        <label className="field">
          <span className="field__label">{t("image.sampler")}</span>
          <select
            className="input"
            value={sampler}
            onChange={(event) => setSampler(event.target.value)}
          >
            <option value="">{t("image.samplerDefault")}</option>
            {(capabilities?.samplers ?? []).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="toggles">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={hires}
            onChange={(event) => setHires(event.target.checked)}
          />
          <span>{t("image.hires")}</span>
        </label>

        {selected && (
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={useInit}
              onChange={(event) => setUseInit(event.target.checked)}
            />
            <span>{t("image.useSelected")}</span>
          </label>
        )}
        {useInit && selected && (
          <label className="field field--inline">
            <span className="field__label">{t("image.strength")}</span>
            <input
              className="input input--compact"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={strength}
              onChange={(event) => setStrength(Number(event.target.value))}
            />
          </label>
        )}
      </div>

      <button type="button" className="button" disabled={!prompt.trim()} onClick={submit}>
        {t("image.run")}
      </button>
    </section>
  );
}

function JobList() {
  const t = useUi((s) => s.t);
  const { overview, cancelJob, clearJobs } = useImages();
  const jobs = overview?.jobs ?? [];
  if (!jobs.length) return null;

  const active = jobs.some(
    (job) => job.state === "queued" || job.state === "generating" || job.state === "saving",
  );

  return (
    <section className="card">
      <div className="gallery__bar">
        <h2 className="card__title">{t("image.jobs")}</h2>
        {!active && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void clearJobs()}
          >
            {t("image.clearJobs")}
          </button>
        )}
      </div>
      <div className="facts">
        {jobs.map((job) => (
          <div className="facts__row" key={job.id}>
            <span className="facts__label">{job.prompt.slice(0, 50)}</span>
            <span className="facts__value">
              {t(`image.state.${job.state}`)} · {(job.ms / 1000).toFixed(0)} sn
              {job.error && ` · ${job.error}`}
              {(job.state === "queued" || job.state === "generating") && (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => void cancelJob(job.id)}
                >
                  {t("image.cancel")}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function GalleryFilters() {
  const t = useUi((s) => s.t);
  const { query, favoritesOnly, setQuery, setFavoritesOnly } = useImages();

  return (
    <div className="gallery__filters">
      <input
        className="input input--compact"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("image.searchPlaceholder")}
      />
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={favoritesOnly}
          onChange={(event) => setFavoritesOnly(event.target.checked)}
        />
        <span>{t("image.favoritesOnly")}</span>
      </label>
    </div>
  );
}

function Detail({ image, busy }: { image: StoredImage; busy: boolean }) {
  const t = useUi((s) => s.t);
  const { toggleFavorite, remove, select } = useImages();

  const rows: Array<[string, string]> = [
    [t("image.prompt"), image.prompt],
    [t("image.negative"), image.negativePrompt || "—"],
    [t("models.loaded"), image.model],
    [t("image.sampler"), `${image.sampler || "?"}${image.scheduler ? ` / ${image.scheduler}` : ""}`],
    [t("image.steps"), String(image.steps)],
    [t("image.cfg"), String(image.cfgScale)],
    [t("image.seed"), String(image.seed)],
    [t("image.size"), `${image.width}×${image.height}${image.hires ? ` · ${t("image.hires")}` : ""}`],
    [t("image.source"), t(`image.sourceKind.${image.source}`)],
    [t("image.duration"), `${(image.ms / 1000).toFixed(1)} sn`],
  ];

  return (
    <section className="card">
      <div className="gallery__bar">
        <h2 className="card__title">{t("image.detail")}</h2>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => select(null)}
        >
          {t("image.close")}
        </button>
      </div>

      <div className="detail">
        <GalleryImage filename={image.filename} alt={image.prompt} className="detail__image" />
        <div className="facts">
          {rows.map(([label, value]) => (
            <div className="facts__row" key={label}>
              <span className="facts__label">{label}</span>
              <span className="facts__value">{value}</span>
            </div>
          ))}
          <div className="facts__row">
            <span className="facts__label" />
            <span className="facts__value detail__actions">
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => void toggleFavorite(image)}
              >
                {image.favorite ? t("image.unfavorite") : t("image.favorite")}
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                disabled={busy}
                onClick={() => void remove(image.id)}
              >
                {t("image.delete")}
              </button>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
