import { useEffect, useState } from "react";
import en from "./locales/en.json";
import da from "./locales/da.json";
import de from "./locales/de.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

// English is the default and the source of truth for keys; other locales fall back to it.
export const LOCALES = { en, es, fr, de, da } as const;
export type Locale = keyof typeof LOCALES;
export type MessageKey = keyof typeof en;

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  da: "Dansk",
};

const STORAGE_KEY = "fct.locale";
const CHANGE_EVENT = "fct-locale-change";

function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && v in LOCALES;
}

// English unless the user has picked another language (project rule: English is the default).
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {}
  return "en";
}

let current: Locale = detectLocale();

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale) {
  current = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {}
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const table = LOCALES[current] as Record<string, string>;
  const template = table[key] ?? en[key] ?? key;
  return vars ? template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? "")) : template;
}

/** Translates a backend error (`code` or `code:detail`) into the current language. */
export function tError(err: unknown): string {
  const raw = String(err);
  const sep = raw.indexOf(":");
  const code = sep === -1 ? raw : raw.slice(0, sep);
  const detail = sep === -1 ? "" : raw.slice(sep + 1);
  const key = `error.${code}`;
  return key in en ? t(key as MessageKey, { detail }) : t("error.unknown", { detail: raw });
}

/** Re-renders the component when the language changes (also across the launcher and overlay windows). */
export function useLocale(): [Locale, (l: Locale) => void] {
  const [locale, setState] = useState(current);
  useEffect(() => {
    const sync = () => setState(current);
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && isLocale(e.newValue)) {
        current = e.newValue;
        sync();
      }
    };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return [locale, setLocale];
}
