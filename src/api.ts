import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { browserPad } from "./browserPad";
import { getLocale, t } from "./i18n";

export type DisplayMode = "fullscreen" | "borderless" | "windowed" | "unknown";

export interface SetupStatus {
  path: string;
  exists: boolean;
  mode: DisplayMode;
}

export interface BridgeInfo {
  port: number;
  paired: boolean;
  pairing_code: string;
  /** Installed extension version (null until it has talked to the app). */
  extension_version: string | null;
  /** The version on the website. */
  extension_latest: string;
  /** Show the pairing code: never paired, or an unpaired extension is asking right now. */
  needs_pairing: boolean;
  /** Chrome or Edge is open (tells "browser closed" from "extension removed or off"). */
  browser_running?: boolean;
  /** The paired extension checked in lately (Chrome runs, the connection works). */
  extension_live: boolean;
}

/** The connected controller (Rust gamepad thread). */
export interface Controller {
  name: string;
  kind: "playstation" | "xbox" | "other";
}

export interface UpdateInfo {
  current: string;
  version: string;
}

/** True when version a is older than b ("0.9.1" < "0.9.2"). */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export interface SyncSummary {
  synced_at: number | null;
  item_count: number;
  player_count: number;
  endpoint_count: number;
  sync_active: boolean;
}

export interface GalleryCardView {
  def_id: number;
  name: string | null;
  rating: number | null;
  position: string | null;
  score: number;
  rareflag: number | null;
  holo: boolean;
  /** known = seen in club, manual(_no) = user mark, unknown = collected but not verifiable yet */
  first_owner: "known" | "manual" | "manual_no" | "scanned" | "scanned_no" | "club_no" | "unknown" | "none";
  /** In-game lineup slot this entry stands for when the card itself is not identified yet. */
  slot: number | null;
  /** EA's market average on the user's own (PC) market, else the lowest Buy Now seen. */
  price: number | null;
  price_at: number | null;
}

/** The user's lineup as read from the in-game set page (and its Swap Player pages). */
export interface InGame {
  total: number | null;
  base: number | null;
  bonus: number | null;
  /** Card points matched the in-game Base Grade. */
  verified: boolean;
  slots: number;
  identified: number;
  ambiguous: number;
  /** Collected cards seen on Swap Player. */
  in_box: number;
  /** Swaps marked done by the user, not read in-game yet. */
  user_swapped: boolean;
  seen_at: number | null;
  /** Our model scores the in-game selection exactly like the game: a gain over it is certain. */
  exact: boolean;
}

export interface SwapSuggestion {
  out: GalleryCardView;
  into: GalleryCardView;
}

/** Gallery page the overlay is following in-game. */
export interface CurrentPage {
  kind: "set" | "swap" | "cards" | "bidding" | "bought";
  set_key: string;
  set_name: string;
  verified: boolean;
  cards_read: number;
  facts_changed: number;
  identified: number;
  ambiguous: number;
}

export interface ShoppingEntry {
  card: GalleryCardView;
  /** Points the set's best score rises by when this card is bought (never first owner). */
  gain: number;
  /** Just bought / packed, not placed in the set yet: shown with a ✓ until it is. */
  got: boolean;
  /** "pack" = packed (first owner), "bought" = bought. */
  got_source?: string | null;
}

export interface ShoppingList {
  key: string;
  name: string;
  slots: number;
  collected: number;
  missing: number;
  score: number;
  entries: ShoppingEntry[];
  /** The whole best selection from the user's own cards (side panel tab "Best selection"). */
  best: BestSelection | null;
}

/** The best selection of a set from the cards the user has – one overview instead of swaps. */
export interface BestSelection {
  total: number;
  base: number;
  bonus: number;
  /** Total of the selection read on the set page in-game. */
  ingame: number | null;
  /** Points over the in-game selection, only when our model scores it exactly like the game; 0 = already the best. */
  gain: number | null;
  /** Most points first; in_selection = already in the in-game selection (null while unknown). */
  cards: { card: GalleryCardView; in_selection: boolean | null }[];
  tags: GalleryTag[];
  /** A few changes from the in-game selection as precise swaps (out → in), in order; empty for big changes. */
  swaps: { out: GalleryCardView | null; into: GalleryCardView; gain: number }[];
}

export type OverlayMode = "panel" | "half" | "full";

/** Live advice on the in-game Swap screen (the game's preview vs. our model). */
export interface SwapAdvice {
  set_key: string;
  set_name: string;
  ingame_delta: number;
  model_delta: number | null;
  /** Our model reproduces the in-game total exactly – only then is our advice shown. */
  model_exact: boolean;
  best: GalleryCardView | null;
  best_gain: number;
  highlighted_is_best: boolean;
  identified: number;
  slots: number;
}

export interface PackedCard {
  def_id: number;
  name: string;
  rating: number | null;
  new: boolean;
  set: string;
  gain: number;
  first_owner: boolean;
  /** Was collected without first owner; this pack made it first owner. */
  upgraded: boolean;
  /** Packed and not first owner before (new card or upgrade). */
  new_first_owner?: boolean;
  /** A new card for an incomplete set: [cards in it afterwards, slots]. */
  fills?: [number, number] | null;
}

export type ToastPayload =
  | { kind: "better"; set_key: string; set_name: string; better: { ingame: number; best: number; gain: number } }
  /** In-game Optimize put in the best selection (proven) – before the user confirms. */
  | { kind: "optimized"; set_key: string; set_name: string; total: number }
  | { kind: "swap"; advice: SwapAdvice }
  | { kind: "pack"; cards: PackedCard[]; regrade: boolean; first_owner: boolean }
  /** Sync progress on top of the game: running (stay out of Ultimate Team), done, aborted. */
  | {
      kind: "sync";
      state: "suggest" | "running" | "done" | "aborted" | "login";
      count?: number;
      reason?: "not_signed_in" | "webapp_not_ready" | "no_extension";
      /** running: what is read right now – the club (count = players so far) or Gallery set done/total. */
      phase?: "club" | "gallery";
      done?: number;
      total?: number;
      set?: string | null;
    }
  /** EA's Auto-Complete question is on screen: it fills by points and can replace first owners. */
  | { kind: "autocomplete"; set_name: string }
  /** A recorder runs and FC-Tracker has no current picture of the game: reads are paused. */
  | { kind: "recording" }
  /** Ultimate Team is loaded: FC-Tracker is running (once per game run). */
  | { kind: "welcome"; players: number }
  /** An incomplete set page: cards in the club can fill its open slots (names/points when certain). */
  | { kind: "fill"; set_name: string; count: number; names: string[]; points: number | null }
  /** A game page is being read (every wait visible). */
  | { kind: "progress"; what: "set" | "swap" | "new_items" | "bidding"; name: string | null }
  /** A page was read and needs nothing from the user. */
  | { kind: "read"; state: "best" | "read" | "unclear" | "nothing_new" | "swap"; set_name: string; cards: number; identified: number; total: number | null };

/** Where the user is in FC 27, read from the screen (session.rs). */
export type GameSession = "closed" | "unknown" | "main_menu" | "ut_selected" | "other_mode" | "in_ultimate_team" | "in_match";
export const syncAllowed = (s: GameSession) => s === "closed" || s === "main_menu" || s === "ut_selected" || s === "other_mode";

/** Settings → Tracking speed (src-tauri/src/speed.rs). Times in ms. */
export interface TrackingPrefs {
  preset: "auto" | "light" | "balanced" | "fast" | "max" | "custom";
  continuous: boolean;
  watch_ms: number;
  same_for_all: boolean;
  all_ms: number;
  still_ms: number;
  animated_ms: number;
  market_ms: number;
}

export interface TrackingInfo {
  prefs: TrackingPrefs;
  effective: TrackingPrefs;
  specs: { threads: number; ram_gb: number; gpu: string | null; on_battery: boolean; recommended: "light" | "balanced" | "fast" };
}

const DEMO_SPEED: TrackingInfo = (() => {
  const p: TrackingPrefs = { preset: "auto", continuous: true, watch_ms: 100, same_for_all: false, all_ms: 1000, still_ms: 150, animated_ms: 1000, market_ms: 500 };
  return { prefs: p, effective: { ...p }, specs: { threads: 16, ram_gb: 32, gpu: "NVIDIA GeForce RTX 4070", on_battery: false, recommended: "fast" } };
})();

export type AfterPlay = "remind" | "auto" | "off";

export interface UiPrefs {
  mode: OverlayMode;
  missing_side: "left" | "right";
  /** FC 27 closed after Ultimate Team: remind to sync (default), sync by itself, or nothing. */
  after_play: AfterPlay;
}

export interface GalleryTag {
  id: number;
  name: string;
  count: number;
  pct: number;
  bonus: number;
  counts: boolean;
}

export interface GradeStep {
  grade: string;
  score: number;
  tokens: number;
}

export interface GallerySet {
  key: string;
  name: string;
  kind: "league" | "club" | "rarity";
  slots: number;
  tracked: boolean;
  total: number;
  collected: number;
  missing: number;
  complete: boolean;
  base: number;
  bonus: number;
  score: number;
  /** The score is the verified in-game total (higher than what we can confirm card by card). */
  from_ingame: boolean;
  tags: GalleryTag[];
  grade: { grade: string | null; points_to_next: number; next: GradeStep | null } | null;
  ladder: GradeStep[];
  tokens: number;
  max_tokens: number;
  verified: boolean;
  lineup: GalleryCardView[];
  top_missing: GalleryCardView[];
  ingame: InGame | null;
  swaps: SwapSuggestion[];
  /** What the in-game category page shows for this set (read without opening it). */
  listed: { score: number | null; filled: [number, number] | null; at: number } | null;
}

/** Gallery → Summary as read in-game, next to what fc-tracker knows. */
export interface GalleryStatus {
  summary: {
    level: number | null;
    score: number | null;
    sets: [number, number] | null;
    s_ranks: [number, number] | null;
    items: number | null;
    holographic: number | null;
    first_owner: number | null;
    at: number;
  } | null;
  collected: number;
  first_owner_known: number;
}

/** In-game regrade worth doing: more cards could be placed, or the best lineup scores higher. */
export function regradeGain(set: GallerySet): { cards: number; points: number } | null {
  const l = set.listed;
  if (!l || !set.tracked) return null;
  const placeable = Math.min(set.collected, set.slots);
  const cards = l.filled ? Math.max(0, placeable - l.filled[0]) : 0;
  const points = l.score != null ? Math.max(0, set.score - l.score) : 0;
  return cards > 0 || points > 0 ? { cards, points } : null;
}

export interface GalleryCategory {
  key: string;
  name: string;
  sets: GallerySet[];
}

// In a plain browser during development there is no Tauri backend; serve sample data instead.
// Sample data outside Tauri: in the dev server, and in the website demo (vite build --mode demo).
/** The browser version (fc-tracker.com/web, `npm run build:web`): the screen is read in the tab. */
export const IS_WEB = import.meta.env.MODE === "web";
const browserDev = (import.meta.env.DEV || import.meta.env.MODE === "demo" || IS_WEB) && !("__TAURI_INTERNALS__" in window);
const mock = <T,>(load: (m: typeof import("./devMock")) => T) => import("./devMock").then(load);
/** Launcher states in the browser: ?demo=unpaired | syncing | running | windowed | outdated | chrome-closed. */
const demo = new URLSearchParams(location.search).get("demo");

const appApi = {
  galleryStatus: () =>
    browserDev
      ? mock((m) => m.mockStatus)
      : invoke<GalleryStatus>("gallery_status"),
  gameSession: () => (browserDev ? Promise.resolve<GameSession>("main_menu") : invoke<GameSession>("game_session")),
  currentPage: () => (browserDev ? mock((m) => m.mockPage) : invoke<CurrentPage | null>("current_page")),
  autoScan: () => (browserDev ? Promise.resolve(true) : invoke<boolean>("auto_scan")),
  setAutoScan: (enabled: boolean) => (browserDev ? Promise.resolve() : invoke<void>("set_auto_scan", { enabled })),
  shoppingList: (key?: string) =>
    browserDev ? mock((m) => m.mockShoppingFor(key)) : invoke<ShoppingList | null>("shopping_list", { key: key ?? null }),
  followSet: (key: string) => (browserDev ? Promise.resolve() : invoke<void>("follow_set", { key })),
  toggleMissingList: () => (browserDev ? Promise.resolve() : invoke<void>("toggle_missing_list")),
  missingListVisible: () => (browserDev ? Promise.resolve(false) : invoke<boolean>("missing_list_visible")),
  uiPrefs: () =>
    browserDev ? Promise.resolve<UiPrefs>({ mode: "panel", missing_side: "left", after_play: "remind" }) : invoke<UiPrefs>("ui_prefs"),
  setOverlayMode: (mode: OverlayMode) =>
    browserDev ? Promise.resolve<UiPrefs>({ mode, missing_side: "left", after_play: "remind" }) : invoke<UiPrefs>("set_overlay_mode", { mode }),
  setMissingSide: (side: "left" | "right") =>
    browserDev ? Promise.resolve<UiPrefs>({ mode: "panel", missing_side: side, after_play: "remind" }) : invoke<UiPrefs>("set_missing_side", { side }),
  /** Settings → Tracking speed. */
  trackingSpeed: () => (browserDev ? Promise.resolve(DEMO_SPEED) : invoke<TrackingInfo>("tracking_speed")),
  setTrackingSpeed: (prefs: TrackingPrefs) =>
    browserDev ? Promise.resolve({ ...DEMO_SPEED, prefs, effective: prefs }) : invoke<TrackingInfo>("set_tracking_speed", { prefs }),
  /** "Start with Windows" (HKCU Run entry, also set by the installer). */
  autostart: () => (browserDev ? Promise.resolve(true) : invoke<boolean>("autostart")),
  setAutostart: (on: boolean) => (browserDev ? Promise.resolve(on) : invoke<boolean>("set_autostart", { on })),
  /** Opens a page of fc-tracker.com, e.g. "/download". */
  openSite: (path: string) => (browserDev ? Promise.resolve() : invoke<void>("open_site", { path })),
  setAfterPlay: (mode: AfterPlay) =>
    browserDev ? Promise.resolve<UiPrefs>({ mode: "panel", missing_side: "left", after_play: mode }) : invoke<UiPrefs>("set_after_play", { mode }),
  syncSuggested: () => (browserDev ? Promise.resolve(new URLSearchParams(location.search).has("suggest")) : invoke<boolean>("sync_suggested")),
  dismissSyncSuggestion: () => (browserDev ? Promise.resolve() : invoke<void>("dismiss_sync_suggestion")),
  galleryOverview: () =>
    browserDev ? mock((m) => m.mockGallery) : invoke<GalleryCategory[]>("gallery_overview"),
  setupStatus: () =>
    browserDev
      ? Promise.resolve<SetupStatus>({ path: "", exists: true, mode: demo === "windowed" ? "windowed" : "borderless" })
      : invoke<SetupStatus>("setup_status"),
  setBorderless: () => invoke<SetupStatus>("set_borderless"),
  gameRunning: () => (browserDev ? Promise.resolve(demo === "running" || demo === "syncing") : invoke<boolean>("game_running")),
  launchGame: () => invoke<void>("launch_game"),
  hideOverlay: () => (browserDev ? Promise.resolve() : invoke<void>("hide_overlay")),
  bridgeInfo: () =>
    browserDev
      ? Promise.resolve<BridgeInfo>({ port: 47827, paired: demo !== "unpaired", pairing_code: "4821", extension_version: demo === "outdated" ? "0.9.1" : "0.9.2", extension_latest: "0.9.2", needs_pairing: demo === "unpaired", extension_live: demo !== "chrome-closed" })
      : invoke<BridgeInfo>("bridge_info"),
  unpair: () => invoke<BridgeInfo>("unpair"),
  setLocale: (locale: string) => invoke<boolean>("set_locale", { locale }),
  /** "Done" on a suggested swap: the stored lineup follows; the next set page read checks it. */
  markSwapDone: (setKey: string, sw: SwapSuggestion) =>
    browserDev
      ? Promise.resolve(true)
      : invoke<boolean>("mark_swap_done", { setKey, outDefId: sw.out.def_id, outSlot: sw.out.slot ?? null, intoDefId: sw.into.def_id }),
  /** The card menu's choice: true = first owner, false = purchased, null = automatic. */
  setFirstOwner: (defId: number, value: boolean | null) =>
    browserDev ? Promise.resolve() : invoke<void>("set_first_owner", { defId, value }),
  syncSummary: () =>
    browserDev
      ? mock((m) => (demo === "syncing" ? { ...m.mockSync, sync_active: true, item_count: 412 } : m.mockSync))
      : invoke<SyncSummary>("sync_summary"),
  startSync: () => invoke<SyncSummary>("start_sync"),
  /** Sync and start FC 27 at once (the user stays out of Ultimate Team until the sync is done). */
  syncAndLaunch: () => invoke<SyncSummary>("sync_and_launch"),
  cancelSync: () => invoke<SyncSummary>("cancel_sync"),
  checkUpdate: () =>
    browserDev
      ? Promise.resolve<UpdateInfo | null>(demo === "outdated" ? { current: "0.1.1", version: "0.1.2" } : null)
      : invoke<UpdateInfo | null>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  controller: () =>
    browserDev ? Promise.resolve<Controller | null>(demo === "xbox" ? { name: "Xbox Wireless Controller", kind: "xbox" } : null) : invoke<Controller | null>("controller"),
  /** From the overlay: the launcher comes forward on Help. */
  openHelp: (topic = "controls") => (browserDev ? Promise.resolve() : invoke<void>("open_help", { topic })),
  appVersion: () => (browserDev ? Promise.resolve("0.1.2") : getVersion()),
  openDataDir: () => invoke<void>("open_data_dir"),
  /** Settings → Diagnostics: save every picture the tracking reads, for 30 minutes. */
  diagnosticsStatus: () => (browserDev ? Promise.resolve({ remaining: null }) : invoke<{ remaining: number | null }>("diagnostics_status")),
  setDiagnostics: (on: boolean) =>
    browserDev ? Promise.resolve({ remaining: on ? 1800 : null }) : invoke<{ remaining: number | null }>("set_diagnostics", { on }),
  openDiagnostics: () => invoke<void>("open_diagnostics"),
};

// The browser version: the gallery comes from the screen read in this tab (src/web/backend.ts).
// Registered by src/web/main.tsx – the app never imports the browser version's code.
type WebBackend = typeof import("./web/backend");
let webBackend: WebBackend | null = null;
export function setWebBackend(b: WebBackend) {
  webBackend = b;
}
const wb = <T,>(f: (b: WebBackend) => T | Promise<T>): Promise<T> =>
  webBackend ? Promise.resolve().then(() => f(webBackend!)) : Promise.reject(new Error("web backend not set"));
function withWeb(a: typeof appApi): typeof appApi {
  return {
    ...a,
    galleryOverview: () => wb((b) => b.webApi.galleryOverview()),
    shoppingList: (key?: string) => wb((b) => b.webApi.shoppingList(key)),
    galleryStatus: () => wb((b) => b.webApi.galleryStatus()),
    currentPage: () => wb((b) => b.webApi.currentPage()),
    followSet: (key: string) => wb((b) => b.webApi.followSet(key)),
    toggleMissingList: () => wb((b) => b.webApi.toggleMissingList()),
    missingListVisible: () => wb((b) => b.webApi.missingListVisible()),
    setFirstOwner: (defId: number, value: boolean | null) => wb((b) => b.webApi.setFirstOwner(defId, value)),
    gameSession: () => wb((b) => (b.webStream() ? "in_ultimate_team" : "closed") as GameSession),
    autoScan: () => wb((b) => b.webStream() != null),
    setAutoScan: (enabled: boolean) => wb((b) => (enabled ? undefined : b.stopCapture())),
    uiPrefs: () => Promise.resolve<UiPrefs>({ mode: "full", missing_side: "right", after_play: "off" }),
    syncSummary: () => Promise.resolve<SyncSummary>({ synced_at: null, item_count: 0, player_count: 0, endpoint_count: 0, sync_active: false }),
    markSwapDone: () => Promise.resolve(false),
    openHelp: () => Promise.resolve(void window.open("/faq", "_blank", "noopener")),
    openSite: (path: string) => Promise.resolve(void window.open(path, "_blank", "noopener")),
    hideOverlay: () => Promise.resolve(),
  };
}
export const api = IS_WEB ? withWeb(appApi) : appApi;

const noListen = (): Promise<UnlistenFn> => Promise.resolve(() => {});
const webListen = <T,>(pick: (b: WebBackend) => (cb: (v: T) => void) => () => void, cb: (v: T) => void): Promise<UnlistenFn> =>
  wb((b) => pick(b)(cb));

// Browser design mode: ?view=toast&demo=pack shows the pack toast, otherwise the swap toast.
function mockToast(cb: (t: ToastPayload) => void): Promise<UnlistenFn> {
  const demo = new URLSearchParams(location.search).get("demo");
  import("./devMock").then((m) =>
    cb(demo === "pack" ? m.mockPackToast : demo === "swap" ? m.mockSwapToast : demo === "login" ? { kind: "sync", state: "login", reason: "not_signed_in" } : demo === "welcome" ? { kind: "welcome", players: 529 } : demo === "suggest" ? { kind: "sync", state: "suggest" } : demo === "fill" ? { kind: "fill", set_name: "Newcastle United", count: 3, names: ["Barnes", "Wissa", "Murphy"], points: 520 } : demo === "recording" ? { kind: "recording" } : demo === "progress" ? { kind: "progress", what: "set", name: "Premier League" } : demo === "read" ? { kind: "read", state: "best", set_name: "Arsenal", cards: 20, identified: 20, total: 114873 } : demo === "syncing" ? { kind: "sync", state: "running", phase: "gallery", count: 186, done: 3, total: 16, set: "Premier League" } : m.mockBetterToast),
  );
  return noListen();
}

const appEvents = {
  onPaired: (cb: () => void): Promise<UnlistenFn> => (browserDev ? noListen() : listen("bridge-paired", () => cb())),
  onSyncUpdate: (cb: (s: SyncSummary) => void) =>
    browserDev ? noListen() : listen<SyncSummary>("sync-update", (e) => cb(e.payload)),
  onSyncDone: (cb: (s: SyncSummary) => void) =>
    browserDev ? noListen() : listen<SyncSummary>("sync-done", (e) => cb(e.payload)),
  onScanDone: (cb: (p: CurrentPage) => void) =>
    browserDev ? noListen() : listen<CurrentPage>("scan-done", (e) => cb(e.payload)),
  /** Auto-tracking read a new Gallery page in-game. */
  onPageChanged: (cb: (p: CurrentPage) => void) =>
    browserDev ? noListen() : listen<CurrentPage>("page-changed", (e) => cb(e.payload)),
  /** Ctrl+Shift+G: show the set that is on screen in-game. */
  /** The background model finished a new overview / missing list (cheap to fetch now). */
  onGalleryUpdated: (cb: () => void) => (browserDev ? noListen() : listen<number>("gallery-updated", () => cb())),
  onFocusSet: (cb: (key: string) => void) =>
    browserDev ? noListen() : listen<string>("focus-set", (e) => cb(e.payload)),
  onMissingSet: (cb: (key: string) => void) =>
    browserDev ? noListen() : listen<string>("missing-set", (e) => cb(e.payload)),
  onGameSession: (cb: (s: GameSession) => void) =>
    browserDev ? noListen() : listen<GameSession>("game-session", (e) => cb(e.payload)),
  /** The user entered Ultimate Team during a sync; the extension closed the Web App. */
  /** Controller: double-tap View / Create on the open side panel – show the other tab. */
  onSyncAborted: (cb: () => void) => (browserDev ? noListen() : listen("sync-aborted", () => cb())),
  /** The Web App isn't signed in (or never loaded the club): the sync waits for the user. */
  onSyncBlocked: (cb: (reason: string) => void) => (browserDev ? noListen() : listen<string>("sync-blocked", (e) => cb(e.payload))),
  onSyncResumed: (cb: () => void) => (browserDev ? noListen() : listen("sync-resumed", () => cb())),
  onSyncSuggested: (cb: (on: boolean) => void) => (browserDev ? noListen() : listen<boolean>("sync-suggested", (e) => cb(e.payload))),
  /** Controller navigation while the overlay is open. */
  // Outside the app (website demo, dev server) the browser's Gamepad API drives the overlay.
  onPad: (cb: (action: string) => void) =>
    browserDev ? Promise.resolve<UnlistenFn>(browserPad.onNav(cb)) : listen<string>("pad", (e) => cb(e.payload)),
  /** Right stick tilt while the overlay is open (−1…1, up positive). */
  onPadScroll: (cb: (v: number) => void) =>
    browserDev ? Promise.resolve<UnlistenFn>(browserPad.onScroll(cb)) : listen<number>("pad-scroll", (e) => cb(e.payload)),
  onController: (cb: (c: Controller | null) => void) =>
    browserDev ? noListen() : listen<Controller | null>("controller", (e) => cb(e.payload)),
  onOpenHelp: (cb: (topic: string) => void) => (browserDev ? noListen() : listen<string>("open-help", (e) => cb(e.payload))),
  onToast: (cb: (t: ToastPayload) => void) =>
    browserDev ? mockToast(cb) : listen<ToastPayload>("toast", (e) => cb(e.payload)),
  /** The overlay is closing by a held button: invisible now, hidden when the button is up. */
  onOverlayVanish: (cb: (vanish: boolean) => void) =>
    browserDev ? noListen() : listen<boolean>("overlay-vanish", (e) => cb(e.payload)),
  /** Opened while a screen recorder runs: no focus, the controller stays with the game. */
  onOverlayPassive: (cb: (passive: boolean) => void) =>
    browserDev ? noListen() : listen<boolean>("overlay-passive", (e) => cb(e.payload)),
  onMissingVisible: (cb: (visible: boolean) => void) =>
    browserDev ? noListen() : listen<boolean>("missing-visible", (e) => cb(e.payload)),
  onScanFailed: (cb: (code: string) => void) =>
    browserDev ? noListen() : listen<string>("scan-failed", (e) => cb(e.payload)),
};

export const events: typeof appEvents = IS_WEB
  ? {
      ...appEvents,
      onGalleryUpdated: (cb: () => void) => webListen((b) => b.webEvents.onGalleryUpdated, () => cb()),
      onPageChanged: (cb: (p: CurrentPage) => void) => webListen((b) => b.webEvents.onPageChanged, cb),
      onFocusSet: (cb: (key: string) => void) => webListen((b) => b.webEvents.onFocusSet, cb),
      onMissingSet: (cb: (key: string) => void) => webListen((b) => b.webEvents.onMissingSet, cb),
      onMissingVisible: (cb: (v: boolean) => void) => webListen((b) => b.webEvents.onMissingVisible, cb),
      onGameSession: (cb: (s: GameSession) => void) =>
        webListen((b) => b.webEvents.onStatus, (st) => cb(st.phase === "off" ? "closed" : "in_ultimate_team")),
      onToast: () => noListen(),
    }
  : appEvents;

export function formatAge(ms: number | null): string {
  if (!ms) return t("time.never");
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.minutesAgo", { count: min });
  const h = Math.round(min / 60);
  if (h < 24) return t("time.hoursAgo", { count: h });
  return new Date(ms).toLocaleString(getLocale(), { dateStyle: "short", timeStyle: "short" });
}
