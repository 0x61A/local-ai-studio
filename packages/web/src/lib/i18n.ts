import { readLocal } from "./storage";
import tr from "../locales/tr.json";
import en from "../locales/en.json";

export const LANGUAGES = ["tr", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

const CATALOGS: Record<Language, unknown> = { tr, en };

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

export function detectLanguage(): Language {
  const stored = readLocal("studio.language");
  if (stored && isLanguage(stored)) return stored;
  const preferred = globalThis.navigator?.language ?? "";
  return preferred.toLowerCase().startsWith("tr") ? "tr" : "en";
}

/**
 * Nokta ayrilmis anahtar arar, {{ad}} yer tutucularini doldurur.
 * Anahtar bulunamazsa anahtarin kendisini dondurur -- eksik ceviri
 * arayuzde gorunur olur, sessizce bos kalmaz.
 */
export function translate(
  language: Language,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const value = lookup(CATALOGS[language], key) ?? lookup(CATALOGS.en, key);
  if (typeof value !== "string") return key;
  if (!vars) return value;
  return value.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

function lookup(catalog: unknown, key: string): unknown {
  let current = catalog;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
