import { useEffect, useState } from "react";

export const THEMES = ["midnight", "pitch", "gold", "glass"] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = "fct.theme";
const CHANGE_EVENT = "fct-theme-change";

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isTheme(saved)) return saved;
  } catch {}
  return "midnight";
}

/** Overlay theme, shared between the launcher and overlay windows (same origin → same storage). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const sync = () => setThemeState(readTheme());
    const onStorage = (e: StorageEvent) => e.key === STORAGE_KEY && sync();
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setTheme = (t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {}
    setThemeState(t);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return [theme, setTheme];
}
