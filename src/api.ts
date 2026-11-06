import { invoke } from "@tauri-apps/api/core";
import { excludedIds } from "./excluded";
import { getVersion } from "@tauri-apps/api/app";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { browserPad } from "./browserPad";
import { getLocale, t } from "./i18n";
import type { ChampsData } from "./championsData";
import type { ClubEntry, SquadPrefs, SquadsView } from "./squadsData";
import { sharePlan } from "./panelShare";

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
  /** The oldest extension this app works with (older ones update themselves, see updates.rs). */
  extension_required?: string;
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
  /** This version must not keep running – every update is forced (updates.rs FORCE_EVERY_UPDATE). */
  required?: boolean;
  /** The feed's `required`: this version can't read the newest data (the overlay blocks too). */
  data_change?: boolean;
  /** Installs by itself once FC 27 is closed (false in a dev build). */
  auto?: boolean;
}

/** The first start after an update ("Updated to …", once). */
export interface UpdatedInfo {
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

/** One card on the Players page (lib.rs CardRow). */
export interface CardRow {
  def_id: number;
  name: string | null;
  rating: number | null;
  position: string | null;
  positions: string[];
  rareflag: number | null;
  nation: number | null;
  league: number | null;
  club: number | null;
  face?: number[];
  art?: string | null;
  score: number;
  holo: boolean;
  first_owner: "known" | "manual" | "manual_no" | "scanned" | "scanned_no" | "club_no" | "unknown" | "none";
  removed: boolean;
  /** Sets whose best selection the card is in. */
  sets: string[];
}

export interface GalleryCardView {
  def_id: number;
  /** EA's art guid: a special's action shot. */
  art?: string | null;
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
  /** The card art beyond the rarity (FutCard's flag · league · club row and face stats) – when the catalog knows them. */
  nation?: number;
  league?: number;
  club?: number;
  face?: number[];
}

/** Best value (DESIGN 9r): a card bought for the Gallery is resold – it costs EA's 5 % tax. */
export interface ValueBuy {
  card: GalleryCardView;
  price: number;
  tax: number;
}
export type PlanState = "reached" | "buy" | "over_budget" | "unpriced" | "not_possible";
export interface GradePlan {
  grade: string;
  score_needed: number;
  tokens: number;
  tokens_total: number;
  state: PlanState;
  score: number;
  buys: ValueBuy[];
  coins_needed: number;
  total_price: number;
  tax: number;
}
export interface SetValue {
  key: string;
  name: string;
  category: string;
  slots: number;
  collected: number;
  score: number;
  grade: string | null;
  tokens_have: number;
  tokens_max: number;
  plans: GradePlan[];
  unpriced: number;
  balance: number | null;
}
export interface PlanStep {
  key: string;
  name: string;
  grade: string;
  tokens: number;
  tax: number;
  coins_needed: number;
  buys: ValueBuy[];
}
export interface TokenPlan {
  steps: PlanStep[];
  tokens: number;
  tax: number;
  total_price: number;
  coins_needed: number;
  players: number;
  balance: number | null;
}
/** The user's coin balance as last seen: read passively from the Web App's own responses during a
 *  club sync (EA's usermassinfo / tradepile – no extra request), or on screen. `read_at` in ms.
 *  Optional everywhere: null until a sync has shown it. */
export interface Coins {
  value: number;
  read_at: number;
}
export interface BestValue {
  coins: [number, number] | null;
  budget: number | null;
  sets: SetValue[];
  plan: TokenPlan;
}

/** For the shared price pool: the account's market and the EA averages seen ([def id, average, at]). */
export interface PriceShare {
  platform: "pc" | "console" | null;
  prices: [number, number, number][];
  /** Lowest Buy Now prices seen in own market results: [id, price, at]. */
  bins?: [number, number, number][];
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
  /** EA's 5 % tax on reselling it (what it really costs for the Gallery), and points per 1,000 of it. */
  tax?: number | null;
  per_k?: number | null;
}

export interface ShoppingList {
  key: string;
  name: string;
  slots: number;
  collected: number;
  missing: number;
  score: number;
  /** Best buys for the coins (known price within the balance), most points per 1K tax first. */
  entries: ShoppingEntry[];
  /** Most valuable: every missing card that adds points, most first – priced or not. */
  valuable?: ShoppingEntry[];
  /** The whole best selection from the user's own cards (side panel tab "Best selection"). */
  best: BestSelection | null;
  /** Cards left out because they cost more than the user's coins, and those coins. */
  over_budget?: number;
  balance?: number | null;
  /** The best value next grade of this set (within the coins). */
  next_grade?: GradePlan | null;
  tokens_have?: number;
  /** Cards in `valuable` without a price seen yet. */
  unpriced?: number;
  /** Every grade reached: buying adds score but no tokens, so nothing is suggested. */
  top_reached?: boolean;
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
  /** An event's hub is on screen: its squad checklist is in the side panel. */
  | { kind: "squads"; event: string }
  /** A match of the objective plan was counted: the squad changes now … */
  | { kind: "squads-swap"; played: number; swaps: { pos: string; out: string; in: string; buy: boolean }[] }
  /** … or not yet (matches until the next change). */
  | { kind: "squads-match"; played: number; next: number | null }
  | { kind: "evo"; evo: string; player: string; active: boolean }
  | { kind: "rules"; event: string; min: number | null; max: number | null; cap?: [number, number] | null }
  | { kind: "objectives-read"; event: string; count: number }
  | { kind: "squad-changes"; done: string | null; swaps: { pos: string; out: string | null; in: string; buy: boolean }[]; counted: number; place: string }
  | { kind: "match-reminder"; at: number; now?: boolean; needs: { player: string; evo: string; level: number; levels: number; start: boolean; bench?: boolean; at: number }[] }
  /** An incomplete set page: cards in the club can fill its open slots (names/points when certain). */
  | { kind: "fill"; set_name: string; count: number; names: string[]; points: number | null }
  /** A game page is being read (every wait visible). */
  | { kind: "progress"; what: "set" | "swap" | "new_items" | "bidding"; name: string | null }
  /** Champions: a match was counted by the hub. */
  | { kind: "champions"; n: number | null; outcome: "win" | "loss" | "quit" | null; score: [number, number] | null; when_left: [number, number] | null; minute: number | null; aet: boolean; opponent: string | null; wins: number; losses: number; remaining: number }
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
  /** In a match (Champions tracker): one look at the scoreboard this often. */
  match_ms: number;
}

export interface TrackingInfo {
  prefs: TrackingPrefs;
  effective: TrackingPrefs;
  specs: { threads: number; ram_gb: number; gpu: string | null; on_battery: boolean; recommended: "light" | "balanced" | "fast" };
}

const DEMO_SPEED: TrackingInfo = (() => {
  const p: TrackingPrefs = { preset: "auto", continuous: true, watch_ms: 100, same_for_all: false, all_ms: 1000, still_ms: 150, animated_ms: 1000, market_ms: 500, match_ms: 1000 };
  return { prefs: p, effective: { ...p }, specs: { threads: 16, ram_gb: 32, gpu: "NVIDIA GeForce RTX 4070", on_battery: false, recommended: "fast" } };
})();

export type AfterPlay = "remind" | "auto" | "off";

export interface UiPrefs {
  mode: OverlayMode;
  missing_side: "left" | "right";
  /** FC 27 closed after Ultimate Team: remind to sync (default), sync by itself, or nothing. */
  after_play: AfterPlay;
  /** Champions tracker (beta) on / off. */
  champions?: boolean;
  /** Settings → Squads. */
  squads?: SquadPrefs;
  /** Settings → Match reminders. */
  reminders?: RemindPrefs;
}

/** Match reminders: the match clock read in every match; minutes to remind at (0 = loading in). */
export interface RemindPrefs {
  on: boolean;
  at: number[];
  /** When bench players are subbed on (each can have his own minute on the bench). */
  sub_at: number;
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
/** Launcher states in the browser: ?demo=unpaired | syncing | running | windowed | outdated | required | updated | chrome-closed. */
const demo = new URLSearchParams(location.search).get("demo");
/** Dev preview of the forced update: ?mock=update (FC 27 closed: countdown) | update-running (waits for FC 27) |
 *  update-data (can't read the newest data) | updated ("Updated to …") | ext-update (the extension updating itself). Account states: account.ts ACCOUNT_MOCK. */
const mockUpd = new URLSearchParams(location.search).get("mock");
const mockUpdate = (): UpdateInfo | null =>
  mockUpd === "update" || mockUpd === "update-running"
    ? { current: "0.1.101", version: "0.2.0", required: true, data_change: false, auto: true }
    : mockUpd === "update-data"
      ? { current: "0.1.101", version: "0.2.0", required: true, data_change: true, auto: true }
      : null;

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
    // the website demo shows the Champions tracker switched on (a weekend in progress)
    browserDev ? Promise.resolve<UiPrefs>({ mode: new URLSearchParams(location.search).get("mode") === "full" ? "full" : "panel", missing_side: "left", after_play: "remind", champions: import.meta.env.MODE === "demo" }) : invoke<UiPrefs>("ui_prefs"),
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
  gameRunning: () => (browserDev ? Promise.resolve(demo === "running" || demo === "syncing" || mockUpd === "update-running") : invoke<boolean>("game_running")),
  launchGame: () => invoke<void>("launch_game"),
  hideOverlay: () => (browserDev ? Promise.resolve() : invoke<void>("hide_overlay")),
  /** A click in an overlay opened without focus (while recording): it takes the focus. */
  overlayFocus: () => (browserDev ? Promise.resolve() : invoke<void>("overlay_focus")),
  bridgeInfo: () =>
    browserDev
      ? Promise.resolve<BridgeInfo>({ port: 47827, paired: demo !== "unpaired", pairing_code: "4821", extension_version: mockUpd === "ext-update" ? "0.12.9" : demo === "outdated" ? "0.9.1" : "0.9.2", extension_latest: mockUpd === "ext-update" ? "0.13.11" : "0.9.2", extension_required: mockUpd === "ext-update" ? "0.13.0" : undefined, needs_pairing: demo === "unpaired", extension_live: demo !== "chrome-closed" })
      : invoke<BridgeInfo>("bridge_info"),
  unpair: () => invoke<BridgeInfo>("unpair"),
  setLocale: (locale: string) => invoke<boolean>("set_locale", { locale }),
  /** The paired extension's popup and badge follow the app's theme (light / dark / glass). */
  setBridgeTheme: (theme: string) => (browserDev ? Promise.resolve(true) : invoke<boolean>("set_bridge_theme", { theme })),
  /** "Done" on a suggested swap: the stored lineup follows; the next set page read checks it. */
  markSwapDone: (setKey: string, sw: SwapSuggestion) =>
    browserDev
      ? Promise.resolve(true)
      : invoke<boolean>("mark_swap_done", { setKey, outDefId: sw.out.def_id, outSlot: sw.out.slot ?? null, intoDefId: sw.into.def_id }),
  /** The coin balance as last seen (null until a sync or the screen has shown it). */
  coins: () =>
    browserDev
      ? import("./devMock").then((m) => m.mockBestValue(null, null, null, [])).then((v): Coins | null => (v?.coins ? { value: v.coins[0], read_at: v.coins[1] } : null))
      : invoke<Coins | null>("coins"),
  /** Best value: every set's grades with their cost, and the token plan (within the coins). */
  bestValue: (budget: number | null = null, target: number | null = null, steps: number | null = null) =>
    browserDev
      ? import("./devMock").then((m) => m.mockBestValue(budget, target, steps, excludedIds()))
      : invoke<BestValue | null>("best_value", { budget, target, steps, exclude: excludedIds() }),
  setValue: (key: string) =>
    browserDev ? import("./devMock").then((m) => m.mockSetValue(key, excludedIds())) : invoke<SetValue | null>("set_value", { key, exclude: excludedIds() }),
  /** The shared price pool (src/prices.ts): what this PC saw, and the pool coming back. */
  priceShare: (since: number) =>
    browserDev ? Promise.resolve<PriceShare>({ platform: null, prices: [] }) : invoke<PriceShare>("price_share", { since }),
  pricePool: (platform: string, prices: Record<string, [number, number]>) =>
    browserDev ? Promise.resolve(0) : invoke<number>("price_pool", { platform, prices }),
  /** The shared pool of paid prices: this PC's purchases since the last call, and the pool back. */
  paidShare: () => (browserDev ? Promise.resolve<PriceShare>({ platform: null, prices: [] }) : invoke<PriceShare>("paid_share")),
  paidPool: (platform: string, prices: Record<string, [number, number, number]>) =>
    browserDev ? Promise.resolve(0) : invoke<number>("paid_pool", { platform, prices }),
  /** The account as every window shows it (Rust account.rs): signed in = Credential Manager; the profile the launcher read. */
  accountView: () =>
    browserDev
      ? Promise.resolve({ signed_in: localStorage.getItem("fct.account") != null, user: null } as AccountView)
      : invoke<AccountView>("account_view"),
  /** The launcher hands the profile it read to the other windows (null on sign-out). */
  setAccountUser: (user: unknown | null) => (browserDev ? Promise.resolve() : invoke<void>("set_account_user", { user })),
  /** The FC-Tracker account (src/account.ts): the saved secret (Credential Manager in the app). */
  accountSecret: () =>
    browserDev ? Promise.resolve(localStorage.getItem("fct.account") ?? null) : invoke<string | null>("account_secret"),
  setAccountSecret: (value: string | null) =>
    browserDev
      ? Promise.resolve(value == null ? localStorage.removeItem("fct.account") : localStorage.setItem("fct.account", value))
      : invoke<void>("set_account_secret", { value }),
  /** One part of this device's data for the account sync (gzip + base64, and when it was
   *  written locally), and another device's part merged in – or taken (`replace`). */
  syncPartExport: (part: string) =>
    browserDev ? Promise.resolve<{ data: string; written_at: number } | null>(null) : invoke<{ data: string; written_at: number }>("sync_part_export", { part }),
  syncPartImport: (part: string, data: string, replace: boolean) =>
    browserDev ? Promise.resolve() : invoke<void>("sync_part_import", { part, data, replace }),
  /** The shared objectives list (src/objectives.ts): this device's events without progress, and
   *  the list from the server merged in (own progress wins). */
  objectivesShare: () => (browserDev ? Promise.resolve<unknown>(null) : invoke<unknown>("objectives_share")),
  applySharedObjectives: (catalog: unknown) => (browserDev ? Promise.resolve(false) : invoke<boolean>("apply_shared_objectives", { catalog })),
  /** Card definitions this PC knows (no ownership) – for FC-Tracker's card list. */
  cardDefs: () => (browserDev ? Promise.resolve<object[]>([]) : invoke<object[]>("card_defs")),
  /** The Gallery set list (src/gallerySets.ts): the revision in use, and a newer one to use. */
  gallerySetsRevision: () => (browserDev ? Promise.resolve(Number.MAX_SAFE_INTEGER) : invoke<number>("gallery_sets_revision")),
  useGallerySets: (json: string) => (browserDev ? Promise.resolve(0) : invoke<number>("use_gallery_sets", { json })),
  /** Set names seen in-game that the list doesn't have yet (each once). */
  takeUnknownSets: () => (browserDev ? Promise.resolve<string[]>([]) : invoke<string[]>("take_unknown_sets")),
  /** The card menu's choice: true = first owner, false = purchased, null = automatic. */
  setFirstOwner: (defId: number, value: boolean | null) =>
    browserDev ? mock((m) => m.mockSetFirstOwner(defId, value)) : invoke<void>("set_first_owner", { defId, value }),
  /** Players: every collected Gallery card (and the ones taken out as wrong reads). */
  galleryCards: () => (browserDev ? mock((m) => m.mockGalleryCards()) : invoke<CardRow[]>("gallery_cards")),
  /** Take a card out as a wrong read (true) or put it back (false). */
  setCardRemoved: (defId: number, removed: boolean) => (browserDev ? mock((m) => m.mockSetRemoved(defId, removed)) : invoke<void>("set_card_removed", { defId, removed })),
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
      ? Promise.resolve<UpdateInfo | null>(mockUpdate() ?? (demo === "outdated" ? { current: "0.1.1", version: "0.1.2", required: true, auto: false } : demo === "required" ? { current: "0.1.1", version: "0.1.2", required: true, data_change: true, auto: false } : null))
      : invoke<UpdateInfo | null>("check_update"),
  /** What the app's update watcher knows (no request). */
  updateState: () =>
    browserDev
      ? Promise.resolve<UpdateInfo | null>(mockUpdate() ?? (demo === "outdated" ? { current: "0.1.1", version: "0.1.2", required: true, auto: false } : demo === "required" ? { current: "0.1.1", version: "0.1.2", required: true, data_change: true, auto: false } : null))
      : invoke<UpdateInfo | null>("update_state"),
  installUpdate: () => (browserDev ? new Promise<void>(() => {}) : invoke<void>("install_update")),
  /** "Updated to …" – once, on the first start after an update (?demo=updated in the browser). */
  updatedNotice: () =>
    browserDev ? Promise.resolve<UpdatedInfo | null>(demo === "updated" || mockUpd === "updated" ? { version: "0.2.0" } : null) : invoke<UpdatedInfo | null>("updated_notice"),
  controller: () =>
    browserDev ? Promise.resolve<Controller | null>(demo === "xbox" ? { name: "Xbox Wireless Controller", kind: "xbox" } : null) : invoke<Controller | null>("controller"),
  /** What's new → all release notes (the public repo's releases). */
  openReleaseNotes: () => (browserDev ? Promise.resolve(void window.open("https://github.com/fc-tracker/fc-tracker/releases", "_blank", "noopener")) : invoke<void>("open_release_notes")),
  /** ○ / B in the launcher: to the tray (tracking keeps running). */
  hideLauncher: () => (browserDev ? Promise.resolve() : invoke<void>("hide_launcher")),
  /** From the launcher's tiles: the overlay opens on that section (event "overlay-section"). */
  openOverlay: (section?: string) => (browserDev ? Promise.resolve() : invoke<void>("open_overlay", { section: section ?? null })),
  /** From the overlay: the launcher comes forward on Help. */
  openHelp: (topic = "controls") => (browserDev ? Promise.resolve() : invoke<void>("open_help", { topic })),
  appVersion: () => (browserDev ? Promise.resolve("0.1.2") : getVersion()),
  openDataDir: () => invoke<void>("open_data_dir"),
  /** Settings → Diagnostics: save every picture the tracking reads, for 30 minutes. */
  diagnosticsStatus: () => (browserDev ? Promise.resolve({ remaining: null }) : invoke<{ remaining: number | null }>("diagnostics_status")),
  setDiagnostics: (on: boolean) =>
    browserDev ? Promise.resolve({ remaining: on ? 1800 : null }) : invoke<{ remaining: number | null }>("set_diagnostics", { on }),
  openDiagnostics: () => invoke<void>("open_diagnostics"),
  /** Champions tracker (beta): everything read from Champions matches (local data). */
  championsData: () =>
    browserDev ? import("./devMock").then((m) => (import.meta.env.MODE === "demo" ? m.demoChampions() : new URLSearchParams(location.search).has("champs-empty") ? m.mockChampionsEmpty : m.mockChampions)) : invoke<ChampsData>("champions_data"),
  setChampionsTracking: (on: boolean) =>
    browserDev ? Promise.resolve<UiPrefs>({ mode: "panel", missing_side: "left", after_play: "remind", champions: on }) : invoke<UiPrefs>("set_champions_tracking", { on }),
  setMatchReminders: (prefs: RemindPrefs) =>
    browserDev ? Promise.resolve<UiPrefs>({ mode: "panel", missing_side: "left", after_play: "remind", reminders: prefs }) : invoke<UiPrefs>("set_match_reminders", { prefs }),
  clearChampions: () => (browserDev ? import("./devMock").then((m) => m.mockChampionsEmpty) : invoke<ChampsData>("clear_champions")),
  /** Objective squads (beta): the open events with squad objectives and the best XI for each. */
  // shared with the other windows (panelShare.ts): the side panel shows the plan the overlay worked out
  squadsPlan: () => (browserDev ? import("./devMock").then((m) => sharePlan(m.mockSquads())) : invoke<SquadsView>("squads_plan").then(sharePlan)),
  setSquadPrefs: (prefs: SquadPrefs) => (browserDev ? import("./devMock").then((m) => m.setMockSquadPrefs(prefs)) : invoke<UiPrefs>("set_squad_prefs", { prefs })),
  setSquadFacts: (facts: Record<string, boolean>) => (browserDev ? Promise.resolve() : invoke<void>("set_squad_facts", { facts })),
  /** "Has to include": every card that exists, not owned (the club list has the owned ones). */
  squadsSearch: (q: string) => (browserDev ? import("./devMock").then((m) => m.mockSquadsSearch(q)) : invoke<ClubEntry[]>("squads_search", { q })),
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
    priceShare: (since: number) => wb((b) => b.webApi.priceShare(since)),
    bestValue: (budget: number | null = null, target: number | null = null, steps: number | null = null) => wb((b) => b.webApi.bestValue(budget, target, steps)),
    coins: () => wb((b) => b.webApi.coins()),
    setValue: (key: string) => wb((b) => b.webApi.setValue(key)),
    pricePool: (platform: string, prices: Record<string, [number, number]>) => wb((b) => b.webApi.pricePool(platform, prices)),
    // no purchases are seen in the browser – it only takes the pool
    paidShare: () => wb((b) => b.webApi.priceShare(Number.MAX_SAFE_INTEGER)),
    paidPool: (platform: string, prices: Record<string, [number, number, number]>) => wb((b) => b.webApi.paidPool(platform, prices)),
    gallerySetsRevision: () => wb((b) => b.webApi.gallerySetsRevision()),
    useGallerySets: (json: string) => wb((b) => b.webApi.useGallerySets(json)),
    gameSession: () => wb((b) => (b.webStream() ? "in_ultimate_team" : "closed") as GameSession),
    autoScan: () => wb((b) => b.webStream() != null),
    setAutoScan: (enabled: boolean) => wb((b) => (enabled ? undefined : b.stopCapture())),
    uiPrefs: () => Promise.resolve<UiPrefs>({ mode: "full", missing_side: "right", after_play: "off" }),
    syncSummary: () => Promise.resolve<SyncSummary>({ synced_at: null, item_count: 0, player_count: 0, endpoint_count: 0, sync_active: false }),
    markSwapDone: () => Promise.resolve(false),
    openHelp: () => Promise.resolve(void window.open("/faq", "_blank", "noopener")),
    openSite: (path: string) => Promise.resolve(void window.open(path, "_blank", "noopener")),
    hideOverlay: () => Promise.resolve(),
    overlayFocus: () => Promise.resolve(),
    // the weekends the app read, from the account (src/account.ts) – else empty
    championsData: () =>
      import("./championsData").then((m) => {
        try {
          const d = JSON.parse(localStorage.getItem("fct.web.champions") ?? "null");
          return d ? ({ ...m.emptyChamps, ...d } as ChampsData) : m.emptyChamps;
        } catch {
          return m.emptyChamps;
        }
      }),
    squadsPlan: () => wb((b) => b.webApi.squadsPlan()).then(sharePlan),
    setSquadPrefs: (prefs: SquadPrefs) => wb((b) => b.webApi.setSquadPrefs(prefs)).then(() => ({ mode: "full", missing_side: "right", after_play: "off" }) as UiPrefs),
    setSquadFacts: (facts: Record<string, boolean>) => wb((b) => b.webApi.setSquadFacts(facts)),
    squadsSearch: (q: string) => wb((b) => b.webApi.squadsSearch(q)),
    // the account: the refresh token stays in this browser; the Gallery and Web App parts are
    // the same format as the app's
    accountSecret: () => Promise.resolve(localStorage.getItem("fct.account") ?? null),
    setAccountSecret: (value: string | null) =>
      Promise.resolve(value == null ? localStorage.removeItem("fct.account") : localStorage.setItem("fct.account", value)),
    syncPartExport: (part: string) => wb((b) => b.syncPartExport(part)),
    syncPartImport: (part: string, data: string, replace: boolean) => wb((b) => b.syncPartImport(part, data, replace)),
    objectivesShare: () => wb((b) => b.objectivesShare()),
    applySharedObjectives: (catalog: unknown) => wb((b) => b.applySharedObjectives(catalog)),
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
    cb(demo && m.mockToasts[demo] ? m.mockToasts[demo] : demo === "pack" ? m.mockPackToast : demo === "swap" ? m.mockSwapToast : demo === "login" ? { kind: "sync", state: "login", reason: "not_signed_in" } : demo === "welcome" ? { kind: "welcome", players: 529 } : demo === "suggest" ? { kind: "sync", state: "suggest" } : demo === "fill" ? { kind: "fill", set_name: "Newcastle United", count: 3, names: ["Barnes", "Wissa", "Murphy"], points: 520 } : demo === "champions" ? { kind: "champions", n: 3, outcome: "loss", score: [4, 5], when_left: null, minute: null, aet: true, opponent: "Basprovol", wins: 1, losses: 2, remaining: 12 } : demo === "recording" ? { kind: "recording" } : demo === "progress" ? { kind: "progress", what: "set", name: "Premier League" } : demo === "read" ? { kind: "read", state: "best", set_name: "Arsenal", cards: 20, identified: 20, total: 114873 } : demo === "syncing" ? { kind: "sync", state: "running", phase: "gallery", count: 186, done: 3, total: 16, set: "Premier League" } : m.mockBetterToast),
  );
  return noListen();
}

/** The account as every window shows it (Rust account::AccountView). */
export type AccountView = { signed_in: boolean; user: unknown | null };

const appEvents = {
  /** Sign-in, sign-out or a new profile – in any window (Rust emits "account-changed"). */
  onAccountChanged: (cb: (v: AccountView) => void) => (browserDev ? noListen() : listen<AccountView>("account-changed", (e) => cb(e.payload))),
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
  /** Champions tracker: a match / the hub was read. */
  onChampions: (cb: (d: ChampsData) => void) => (browserDev ? noListen() : listen<ChampsData>("champions", (e) => cb(e.payload))),
  /** The app read an event's hub in the game: its squad checklist (the objective group id). */
  onSquadsFocus: (cb: (id: number) => void) => (browserDev ? noListen() : listen<number>("squads-focus", (e) => cb(e.payload))),
  onSquadsChanged: (cb: () => void) => (browserDev ? noListen() : listen("squads-changed", () => cb())),
  /** The game's Squad screen was read: its XI compared with the plan's (live squad check). */
  onSquadSeen: (cb: (s: SquadSeen) => void) => (browserDev ? noListen() : listen<SquadSeen>("squad-seen", (e) => cb(e.payload))),
  /** In a match: the clock as read (minutes) and the subs still to come – the side panel's match brief. */
  onMatchClock: (cb: (c: MatchClock) => void) => (browserDev ? noListen() : listen<MatchClock>("match-clock", (e) => cb(e.payload))),
  /** The update watcher found a release (or one went away) – at once, no reload needed. */
  onUpdate: (cb: (u: UpdateInfo | null) => void) => (browserDev ? noListen() : listen<UpdateInfo | null>("update", (e) => cb(e.payload))),
  /** The app started installing an update (button, countdown, or by itself once FC 27 closed). */
  onUpdateInstalling: (cb: (version: string) => void) => (browserDev ? noListen() : listen<string>("update-installing", (e) => cb(e.payload))),
};

/** The game's Squad screen compared with the plan's XI: who still has to come in. */
/** The game's Squad screen read: `confirmed` = planned players seen on the pitch; `missing` (who is
 *  still to come in) only counts when `complete` – the whole XI was read. */
/** The match clock (minute) and who is still to come on (remind.rs). */
export type MatchClock = { minute: number; needs: { player: string; evo: string; level: number; levels: number; start: boolean; bench: boolean; at: number }[] };
export type SquadSeen = { matched: number; total: number; missing: { pos: string; name: string }[]; confirmed: string[]; complete: boolean; at: number };

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
      onChampions: () => noListen(),
      onAccountChanged: () => noListen(),
      onSquadsFocus: () => noListen(),
      onSquadsChanged: () => noListen(),
      onSquadSeen: () => noListen(),
      onMatchClock: () => noListen(),
      onUpdate: () => noListen(),
      onUpdateInstalling: () => noListen(),
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
