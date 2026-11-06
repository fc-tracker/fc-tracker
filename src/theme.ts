import { useEffect, useState } from "react";
import { api } from "./api";

/** Brand v2 themes (design/d-draft-2): light, dark and dark glass. Glass is the default for new installs. */
export const THEMES = ["light", "dark", "glass"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "glass";

// The app keeps its own; on fc-tracker.com the site, FC-Tracker Web and the dashboard share the site's key (user
// 2026-11-05: "the dashboard has its own theme") – one choice for the whole site.
const IN_APP = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const STORAGE_KEY = IN_APP ? "fct.theme" : "fct-theme";

// The app (Tauri) or a browser page: in the app the overlay's glass has no game to blur (themes.css data-host).
if (typeof document !== "undefined") document.documentElement.dataset.host = "__TAURI_INTERNALS__" in window ? "app" : "web";
const CHANGE_EVENT = "fct-theme-change";

/** v1 themes (before brand v2) → their v2 theme. Midnight and Pitch were dark, Gold read as light. */
const LEGACY: Record<string, Theme> = { midnight: "dark", pitch: "dark", gold: "light", glass: "glass" };

function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

/** A saved value → a v2 theme: v2 names pass, v1 names migrate, anything else is the default. */
export function migrateTheme(saved: string | null | undefined): Theme {
  if (isTheme(saved)) return saved;
  if (saved && LEGACY[saved]) return LEGACY[saved];
  return DEFAULT_THEME;
}

/** `?theme=light|dark|glass` shows a page in that theme without saving it (previews, screenshots, /web links). */
const urlTheme = (() => {
  try {
    const v = new URLSearchParams(location.search).get("theme");
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
})();

function readTheme(): Theme {
  if (urlTheme) return urlTheme;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const theme = migrateTheme(saved);
    // write the migrated value back once, so every window (launcher, overlay, side panel) reads the same name
    if (saved !== null && saved !== theme) localStorage.setItem(STORAGE_KEY, theme);
    return theme;
  } catch {}
  return DEFAULT_THEME;
}

/** Overlay theme, shared between the launcher and overlay windows (same origin → same storage). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // the extension follows the app's theme over the bridge (v2-extension); skipped where the command isn't there yet
    const bridge = (api as unknown as { setBridgeTheme?: (t: Theme) => Promise<unknown> }).setBridgeTheme;
    if (typeof bridge === "function") void bridge(theme).catch?.(() => {});
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
