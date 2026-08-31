import { useEffect, useState } from "react";
import { api, type SearchProviderInfo } from "../../lib/api";
import { useUi } from "../../stores/ui";

/**
 * Arama sağlayıcı anahtarları. Anahtar yoksa DuckDuckGo kazımasına
 * düşülür; kazıma kırılgan olduğu için bunu açıkça söylüyoruz.
 */
export function SearchKeys() {
  const t = useUi((s) => s.t);
  const [providers, setProviders] = useState<SearchProviderInfo[]>([]);

  const load = () =>
    void api
      .agentStatus()
      .then((status) => setProviders(status.searchProviders))
      .catch(() => undefined);

  useEffect(load, []);

  return (
    <section className="card">
      <h2 className="card__title">{t("search.title")}</h2>
      <p className="facts__note">{t("search.note")}</p>
      <div className="key-list">
        {providers
          .filter((provider) => provider.requiresApiKey)
          .map((provider) => (
            <SearchKey key={provider.id} provider={provider} onSaved={load} />
          ))}
      </div>
    </section>
  );
}

function SearchKey({
  provider,
  onSaved,
}: {
  provider: SearchProviderInfo;
  onSaved: () => void;
}) {
  const t = useUi((s) => s.t);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  return (
    <div className="key">
      <div className="key__head">
        <span className="key__label">
          {provider.label}
          {provider.available && <span className="key__masked"> · {t("search.active")}</span>}
        </span>
        {!provider.available && (
          <a className="key__link" href={provider.keyUrl} target="_blank" rel="noreferrer noopener">
            {t("settings.getKey")}
          </a>
        )}
      </div>
      <form
        className="key__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          setStatus(t("settings.saving"));
          void api
            .setProviderKey(provider.id, value.trim())
            .then(() => {
              setValue("");
              setStatus(null);
              onSaved();
            })
            .catch((err: Error) => setStatus(err.message));
        }}
      >
        <input
          className="input input--compact"
          type="password"
          autoComplete="off"
          value={value}
          placeholder={t("settings.addKey")}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="button button--small" disabled={!value.trim()}>
          {t("settings.save")}
        </button>
      </form>
      {status && <p className="facts__note">{status}</p>}
    </div>
  );
}
