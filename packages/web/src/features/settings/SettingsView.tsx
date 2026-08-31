import { useEffect, useState } from "react";
import { api, type Preferences } from "../../lib/api";
import { useModels } from "../../stores/models";
import { useUi } from "../../stores/ui";

export function SettingsView() {
  const t = useUi((s) => s.t);
  const { providers, refresh } = useModels();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void refresh();
    void api.settings().then((result) => setPreferences(result.preferences));
  }, [refresh]);

  const save = async (patch: Partial<Preferences>) => {
    const result = await api.saveSettings(patch);
    setPreferences(result.preferences);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
