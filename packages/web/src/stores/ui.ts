import { create } from "zustand";
import { detectLanguage, translate, type Language } from "../lib/i18n";
import { readLocal, writeLocal } from "../lib/storage";

export type Theme = "light" | "dark";

interface UiState {
  language: Language;
  theme: Theme;
  setLanguage: (language: Language) => void;
  setTheme: (theme: Theme) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

function detectTheme(): Theme {
  const stored = readLocal("studio.theme");
  if (stored === "light" || stored === "dark") return stored;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export const useUi = create<UiState>((set, get) => ({
  language: detectLanguage(),
  theme: detectTheme(),
  setLanguage: (language) => {
    writeLocal("studio.language", language);
    document.documentElement.lang = language;
    set({ language });
  },
  setTheme: (theme) => {
    writeLocal("studio.theme", theme);
    document.documentElement.dataset["theme"] = theme;
    set({ theme });
  },
  t: (key, vars) => translate(get().language, key, vars),
}));
