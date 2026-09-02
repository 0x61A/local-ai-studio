import { useEffect, useState } from "react";
import { api, type PowerMode, type Preferences } from "../../lib/api";
import { useModels } from "../../stores/models";
import { useUi } from "../../stores/ui";
import { McpPanel } from "./McpPanel";
import { SearchKeys } from "./SearchKeys";

export function SettingsView() {
  const t = useUi((s) => s.t);
  const providers = useModels((s) => s.providers);
  const refresh = useModels((s) => s.refresh);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    void api.settings().then((result) => setPreferences(result.preferences));
  }, [refresh]);

  const save = async (patch: Partial<Preferences>) => {
    // Iyimser guncelleme: anahtar/slider aninda tepki versin.
    const previous = preferences;
    setPreferences((prev) => (prev ? { ...prev, ...patch } : (patch as Preferences)));
    try {
      const result = await api.saveSettings(patch);
      setPreferences((prev) => ({
        ...(prev ?? {}),
        ...(result.preferences ?? {}),
        ...patch,
      } as Preferences));
      setSaveError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      // Sessizce yutmak, kaydedilmemis bir ayari kaydedilmis gostermek olurdu.
      setPreferences(previous);
      setSaveError(t("settings.saveFailed", { message: (err as Error).message }));
    }
  };

  return (
    <div className="main__inner">
      <h1 className="page-title">{t("nav.settings")}</h1>

      <section className="card">
        <h2 className="card__title">{t("settings.keys")}</h2>
        <p className="facts__note">{t("settings.keysNote")}</p>
        <div className="key-list">
          {providers
            .filter((provider) => provider.capabilities.requiresApiKey)
            .map((provider) => (
              <ProviderKey
                key={provider.id}
                id={provider.id}
                label={provider.label}
                keyUrl={provider.keyUrl}
                masked={provider.maskedKey}
                onChanged={refresh}
              />
            ))}
        </div>
      </section>

      <SearchKeys />

      <McpPanel />

      {saveError && (
        <p className="chat__error" role="alert">
          {saveError}
        </p>
      )}

      {preferences && <ResourceThermalPanel preferences={preferences} save={save} />}

      {preferences && (
        <section className="card">
          <h2 className="card__title">{t("settings.defaults")}</h2>
          <div className="facts">
            <label className="facts__row">
              <span className="facts__label">{t("settings.systemPrompt")}</span>
              <textarea
                className="input"
                rows={3}
                defaultValue={preferences.systemPrompt}
                placeholder={t("settings.systemPromptPlaceholder")}
                onBlur={(event) => void save({ systemPrompt: event.target.value })}
              />
            </label>

            <label className="facts__row">
              <span className="facts__label">
                {t("settings.temperature")} ({preferences.temperature})
              </span>
              <input
                className="input"
                type="range"
                min={0}
                max={2}
                step={0.1}
                defaultValue={preferences.temperature}
                onChange={(event) =>
                  setPreferences({ ...preferences, temperature: Number(event.target.value) })
                }
                onMouseUp={(event) =>
                  void save({ temperature: Number(event.currentTarget.value) })
                }
              />
            </label>

            <label className="facts__row">
              <span className="facts__label">{t("settings.maxTokens")}</span>
              <input
                className="input"
                type="number"
                min={1}
                max={200000}
                defaultValue={preferences.maxTokens}
                onBlur={(event) => void save({ maxTokens: Number(event.target.value) })}
              />
            </label>
          </div>
          {saved && <p className="facts__note">{t("settings.saved")}</p>}
        </section>
      )}
    </div>
  );
}

function ProviderKey({
  id,
  label,
  keyUrl,
  masked,
  onChanged,
}: {
  id: string;
  label: string;
  keyUrl: string;
  masked: string | null;
  onChanged: () => Promise<void>;
}) {
  const t = useUi((s) => s.t);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const submit = async () => {
    if (!value.trim()) return;
    setStatus(t("settings.saving"));
    try {
      await api.setProviderKey(id, value.trim());
      // Anahtar hiçbir zaman geri okunmaz; alanı hemen temizleriz.
      setValue("");
      setStatus(null);
      await onChanged();
    } catch (err) {
      setStatus((err as Error).message);
    }
  };

  const remove = async () => {
    await api.deleteProviderKey(id);
    setStatus(null);
    await onChanged();
  };

  return (
    <div className="key">
      <div className="key__head">
        <span className="key__label">{label}</span>
        {masked ? (
          <span className="key__masked">{masked}</span>
        ) : (
          <a className="key__link" href={keyUrl} target="_blank" rel="noreferrer noopener">
            {t("settings.getKey")}
          </a>
        )}
      </div>
      <form
        className="key__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="input input--compact"
          type="password"
          autoComplete="off"
          value={value}
          placeholder={masked ? t("settings.replaceKey") : t("settings.addKey")}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="button button--small" disabled={!value.trim()}>
          {t("settings.save")}
        </button>
        {masked && (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void remove()}
          >
            {t("settings.remove")}
          </button>
        )}
      </form>
      {status && <p className="facts__note">{status}</p>}
    </div>
  );
}

const MODES: PowerMode[] = ["performance", "balanced", "eco", "custom"];
const MODE_ICONS: Record<PowerMode, string> = {
  performance: "⚡",
  balanced: "⚖️",
  eco: "🍃",
  custom: "🛠️",
};
const MODE_LABEL_KEY: Record<PowerMode, string> = {
  performance: "settings.powerPerformance",
  balanced: "settings.powerBalanced",
  eco: "settings.powerEco",
  custom: "settings.powerCustom",
};
const MODE_DESC_KEY: Record<PowerMode, string> = {
  performance: "settings.powerPerformanceDesc",
  balanced: "settings.powerBalancedDesc",
  eco: "settings.powerEcoDesc",
  custom: "settings.powerCustomDesc",
};
/** Cekirdek yuzdesi. Bicimi dile birakiyoruz: "%70" ile "70%" ayni degil. */
const MODE_BADGE_PERCENT: Record<PowerMode, number | null> = {
  performance: 100,
  balanced: 70,
  eco: 35,
  custom: null,
};
const MODE_BADGE_CLASS: Record<PowerMode, string> = {
  performance: "badge--accent",
  balanced: "badge--success",
  eco: "badge--warning",
  custom: "",
};

function ResourceThermalPanel({
  preferences,
  save,
}: {
  preferences: Preferences;
  save: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const t = useUi((s) => s.t);
  const [systemInfo, setSystemInfo] = useState<{ physicalCores: number } | null>(null);
  // Kendi yerel state'imiz — üst bileşenin async save'inden bağımsız, anında tepki verir.
  const [localMode, setLocalMode] = useState<PowerMode>(preferences.powerMode ?? "balanced");
  const [localThreads, setLocalThreads] = useState(preferences.cpuThreads ?? 0);
  const [localUbatch, setLocalUbatch] = useState(preferences.ubatchSize ?? 256);
  const [localGpu, setLocalGpu] = useState(preferences.gpuOffload !== false);

  useEffect(() => {
    void api.system().then((sys) => {
      setSystemInfo({ physicalCores: sys.cpu.physicalCores });
    });
  }, []);

  const maxCores = systemInfo?.physicalCores || 8;
  const displayThreads =
    localThreads > 0 ? localThreads : Math.max(1, Math.round(maxCores * 0.7));

  const selectMode = (mode: PowerMode) => {
    setLocalMode(mode);
    void save({ powerMode: mode });
  };

  // Slider surukleme sirasinda yalnizca yerel state degisir. Her tikta POST
  // atmak 16 cekirdekli bir makinede tek surukleyiste 16 veritabani yazimi
  // demekti; kayit birakilinca yapilir.
  const updateThreads = (n: number) => setLocalThreads(n);
  const commitThreads = () => {
    if (localThreads !== (preferences.cpuThreads ?? 0)) {
      void save({ cpuThreads: localThreads });
    }
  };

  const updateUbatch = (n: number) => {
    setLocalUbatch(n);
    void save({ ubatchSize: n });
  };

  const updateGpu = (on: boolean) => {
    setLocalGpu(on);
    void save({ gpuOffload: on });
  };

  return (
    <section className="card">
      <h2 className="card__title">{t("settings.resourceTitle")}</h2>
      <p className="facts__note">{t("settings.resourceNote")}</p>
      <p className="facts__note">{t("settings.resourceApplyNote")}</p>

      <div className="power-grid">
        {MODES.map((mode) => {
          const active = localMode === mode;
          return (
            <button
              key={mode}
              type="button"
              className={`power-card${active ? " power-card--active" : ""}`}
              onClick={() => selectMode(mode)}
            >
              <div className="power-card__header">
                <span className="power-card__title">
                  <span className="power-card__radio">
                    <span className="power-card__radio-dot" />
                  </span>
                  {MODE_ICONS[mode]} {t(MODE_LABEL_KEY[mode])}
                </span>
                {MODE_BADGE_PERCENT[mode] !== null && (
                  <span className={`badge ${MODE_BADGE_CLASS[mode]}`}>
                    {t("settings.powerPercent", { n: MODE_BADGE_PERCENT[mode] })}
                  </span>
                )}
              </div>
              <p className="power-card__desc">{t(MODE_DESC_KEY[mode])}</p>
              {active && (
                <span className="power-card__check">✓ {t("settings.selected")}</span>
              )}
            </button>
          );
        })}
      </div>

      {localMode === "custom" && (
        <div className="custom-controls">
          <label className="facts__row">
            <span className="facts__label">
              {t("settings.cpuThreads")}: {t("settings.cpuThreadsVal", { n: displayThreads })} / {maxCores}
            </span>
            <input
              className="input"
              type="range"
              min={1}
              max={maxCores}
              step={1}
              value={displayThreads}
              onChange={(e) => updateThreads(Number(e.target.value))}
              onPointerUp={commitThreads}
              onBlur={commitThreads}
              onKeyUp={commitThreads}
            />
          </label>

          <label className="facts__row">
            <span className="facts__label">{t("settings.ubatchSize")}</span>
            <select
              className="input"
              value={localUbatch}
              onChange={(e) => updateUbatch(Number(e.target.value))}
            >
              <option value={64}>{t("settings.ubatch64")}</option>
              <option value={128}>{t("settings.ubatch128")}</option>
              <option value={256}>{t("settings.ubatch256")}</option>
              <option value={512}>{t("settings.ubatch512")}</option>
            </select>
          </label>
          <p className="facts__note" style={{ margin: 0 }}>
            {t("settings.ubatchDesc")}
          </p>

          <label className="custom-controls__toggle">
            <input
              type="checkbox"
              checked={localGpu}
              onChange={(e) => updateGpu(e.target.checked)}
            />
            <span>{t("settings.gpuOffload")}</span>
          </label>
          <p className="facts__note" style={{ margin: 0 }}>
            {t("settings.gpuOffloadDesc")}
          </p>
        </div>
      )}
    </section>
  );
}
