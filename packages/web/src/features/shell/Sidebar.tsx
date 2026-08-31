import { useUi } from "../../stores/ui";

/** Faz 0'da yalnizca Sistem aktif; digerleri kendi fazlarinda acilir. */
const NAV = [
  { id: "system", labelKey: "system.title", ready: true },
  { id: "chat", labelKey: "nav.chat", ready: false },
  { id: "agent", labelKey: "nav.agent", ready: false },
  { id: "models", labelKey: "nav.models", ready: false },
  { id: "knowledge", labelKey: "nav.knowledge", ready: false },
  { id: "image", labelKey: "nav.image", ready: false },
  { id: "audio", labelKey: "nav.audio", ready: false },
  { id: "settings", labelKey: "nav.settings", ready: false },
] as const;

export function Sidebar() {
  const { t, theme, setTheme, language, setLanguage } = useUi();

  return (
    <aside className="shell__sidebar">
      <div>
        <p className="brand__name">{t("app.name")}</p>
        <p className="brand__tagline">{t("app.tagline")}</p>
      </div>

      <nav className="nav" aria-label={t("app.name")}>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className="nav__item"
            disabled={!item.ready}
            aria-current={item.ready ? "page" : undefined}
          >
            <span>{t(item.labelKey)}</span>
            {!item.ready && (
              <span className="nav__badge">{t("nav.comingSoon")}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        <button
          type="button"
          className="toggle"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {t("common.theme")}: {theme === "dark" ? "Dark" : "Light"}
        </button>
        <button
          type="button"
          className="toggle"
          onClick={() => setLanguage(language === "tr" ? "en" : "tr")}
        >
          {language.toUpperCase()}
        </button>
      </div>
    </aside>
  );
}
