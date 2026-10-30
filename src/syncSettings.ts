// The settings that follow the user to every device (account sync, part "settings"): look,
// language, hidden cards, overlay layout, squad options, the Champions switches. What belongs to
// one PC stays on it – window positions, the game's path, the tracking speed tuned to the PC's
// hardware, the extension pairing, the anonymous install id.
import { api, IS_WEB, type UiPrefs } from "./api";
import { setLocale, type Locale } from "./i18n";

const SHARED_KEYS = [
  "fct.theme",
  "fct.locale",
  "fct.excluded",
  "fct.champs.board",
  "fct.champs.news",
  "fct.padLayout",
  "fct.section",
  "fct.squads.event",
  "fct.embedMissing",
  "fct.zoom",
  "fct.howSeen",
  "fct.usage.off",
];
const SEEN = "fct.sync.settings.seen";
const AT = "fct.sync.settings.at";

export type SharedSettings = { ls: Record<string, string | null>; ui?: Partial<UiPrefs> };

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {}
  },
};

async function collect(): Promise<SharedSettings> {
  const value: SharedSettings = { ls: Object.fromEntries(SHARED_KEYS.map((k) => [k, ls.get(k)])) };
  if (!IS_WEB) {
    const p = await api.uiPrefs().catch(() => null);
    if (p) value.ui = { mode: p.mode, missing_side: p.missing_side, after_play: p.after_play, champions: p.champions, squads: p.squads };
  }
  return value;
}

export async function readSettings(): Promise<{ value: SharedSettings; writtenAt: number }> {
  const value = await collect();
  // the moment the settings last changed here: when they differ from what was seen last time
  const now = JSON.stringify(value);
  if (ls.get(SEEN) !== now) {
    ls.set(SEEN, now);
    ls.set(AT, String(Date.now()));
  }
  return { value, writtenAt: Number(ls.get(AT) ?? 0) };
}

/** Another device's settings: taken (`replace`), or added where this device has none. */
export async function applySettings(incoming: SharedSettings, replace: boolean): Promise<void> {
  for (const k of SHARED_KEYS) {
    if (!(k in (incoming.ls ?? {}))) continue;
    const theirs = incoming.ls[k];
    if (replace || ls.get(k) == null) ls.set(k, theirs);
  }
  const locale = ls.get("fct.locale");
  if (locale) setLocale(locale as Locale);
  window.dispatchEvent(new Event("fct-theme-change"));
  window.dispatchEvent(new Event("fct-settings-synced"));
  const ui = incoming.ui;
  if (ui && replace) {
    const mine = await api.uiPrefs().catch(() => null);
    if (!mine) return;
    if (!IS_WEB && ui.mode && ui.mode !== mine.mode) await api.setOverlayMode(ui.mode).catch(() => {});
    if (!IS_WEB && ui.missing_side && ui.missing_side !== mine.missing_side) await api.setMissingSide(ui.missing_side).catch(() => {});
    if (!IS_WEB && ui.after_play && ui.after_play !== mine.after_play) await api.setAfterPlay(ui.after_play).catch(() => {});
    if (!IS_WEB && ui.champions != null && ui.champions !== mine.champions) await api.setChampionsTracking(ui.champions).catch(() => {});
    if (ui.squads && JSON.stringify(ui.squads) !== JSON.stringify(mine.squads)) await api.setSquadPrefs(ui.squads).catch(() => {});
  }
  // the applied settings are what this device has now – not a local change to send back
  ls.set(SEEN, JSON.stringify(await collect()));
}
