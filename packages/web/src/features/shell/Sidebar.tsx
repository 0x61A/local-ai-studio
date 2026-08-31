import { useUi } from "../../stores/ui";

export type TabId = "chat" | "agent" | "models" | "settings" | "system";

interface NavItem {
  id: TabId | string;
  labelKey: string;
  ready: boolean;
}

const NAV: NavItem[] = [
  { id: "chat", labelKey: "nav.chat", ready: true },
  { id: "models", labelKey: "nav.models", ready: true },
  { id: "agent", labelKey: "nav.agent", ready: true },
  { id: "knowledge", labelKey: "nav.knowledge", ready: false },
  { id: "image", labelKey: "nav.image", ready: false },
  { id: "audio", labelKey: "nav.audio", ready: false },
  { id: "settings", labelKey: "nav.settings", ready: true },
  { id: "system", labelKey: "system.title", ready: true },
];

export function Sidebar({
  active,
  onSelect,
}: {
  active: TabId;
  onSelect: (tab: TabId) => void;
}) {
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
            aria-current={item.ready && item.id === active ? "page" : undefined}
            onClick={() => item.ready && onSelect(item.id as TabId)}
          >
            <span>{t(item.labelKey)}</span>
            {!item.ready && <span className="nav__badge">{t("nav.comingSoon")}</span>}
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
