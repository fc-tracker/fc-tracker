// Sample data so the UI can be designed in a plain browser (no Tauri backend) – the dev server
// and the website demo (`npm run build:demo`). It is real FC 27 data: what the app's own model
// computes from a synced club (scripts/demo-data.mjs → src/demoData.json).
import type { CurrentPage, GalleryCategory, GalleryStatus, ShoppingList, SyncSummary, ToastPayload } from "./api";
import demo from "./demoData.json";
import type { ChampsData } from "./championsData";
import { exampleChamps } from "./championsExample";

export const mockGallery = demo.overview as unknown as GalleryCategory[];
const shopping = demo.shopping as unknown as ShoppingList[];
const allSets = mockGallery.flatMap((c) => c.sets);
const premierLeague = allSets.find((s) => s.name === "Premier League") ?? allSets[0];

/** The missing list of a set (the Premier League one when none is picked yet). */
// `?set=<name>` picks another set in the browser preview.
const previewSet = typeof location !== "undefined" ? new URLSearchParams(location.search).get("set") : null;
const findShopping = (key?: string): ShoppingList | null =>
  shopping.find((s) => (key ? s.key === key : previewSet ? s.name === previewSet : s.key === premierLeague.key)) ?? null;
// ?swaps: the best selection shows two precise swaps made from the set's own cards (design only)
// ?prices: EA's market averages as read on the PC market on 2026-10-21 (Web App search results) –
// shows the price column of Buy next (design only)
const EA_AVG_2026_10_21: Record<number, number> = { 239085: 46_750, 158023: 19_500, 277643: 192_666, 50415142: 2_200_000, 50600784: 4_200_000, 67378000: 3_897_000 };
const withPrices = (list: ShoppingList | null): ShoppingList | null => {
  if (!list || !new URLSearchParams(location.search).has("prices")) return list;
  const at = Date.now() - 40 * 60_000;
  const priced = (c: ShoppingList["entries"][number]["card"]) => (EA_AVG_2026_10_21[c.def_id] ? { ...c, price: EA_AVG_2026_10_21[c.def_id], price_at: at } : c);
  return { ...list, entries: list.entries.map((e) => ({ ...e, card: priced(e.card) })) };
};
export const mockShoppingFor = (key?: string): ShoppingList | null => withPrices(rawShoppingFor(key));
const rawShoppingFor = (key?: string): ShoppingList | null => {
  const list = findShopping(key);
  if (!list?.best || !new URLSearchParams(location.search).has("swaps")) return list;
  const c = list.best.cards.map((b) => b.card);
  if (c.length < 4) return list;
  return { ...list, best: { ...list.best, swaps: [ { out: c[c.length - 1], into: c[1], gain: 546 }, { out: c[c.length - 2], into: c[2], gain: 1676 } ] } };
};
export const mockShopping = mockShoppingFor();

export const mockStatus: GalleryStatus = {
  summary: { ...(demo.summary as unknown as GalleryStatus["summary"]), at: Date.now() },
  collected: demo.collected,
  first_owner_known: demo.summary.first_owner ?? 0,
} as GalleryStatus;

export const mockSync: SyncSummary = {
  synced_at: Date.now() - 3 * 60_000, item_count: 1_204, player_count: demo.collected, endpoint_count: 12, sync_active: false,
};

export const mockPage: CurrentPage = {
  kind: "set", set_key: premierLeague.key, set_name: premierLeague.name, verified: true,
  cards_read: premierLeague.lineup.length, facts_changed: 0, identified: premierLeague.lineup.length, ambiguous: 0,
};

const card = (name: string) => allSets.flatMap((s) => s.lineup).find((c) => c.name === name) ?? premierLeague.lineup[0];

export const mockSwapToast: ToastPayload = {
  kind: "swap",
  advice: {
    set_key: premierLeague.key, set_name: premierLeague.name, ingame_delta: -1760, model_delta: -1760, model_exact: true,
    best: card("Konsa"), best_gain: 2345, highlighted_is_best: false, identified: 30, slots: 30,
  },
};

export const mockBetterToast: ToastPayload = {
  kind: "better",
  set_key: premierLeague.key,
  set_name: premierLeague.name,
  better: { ingame: premierLeague.score - 4_367, best: premierLeague.score, gain: 4_367 },
};

export const mockPackToast: ToastPayload = {
  kind: "pack",
  regrade: true,
  first_owner: true,
  cards: [
    { def_id: 1, name: "Kroupi", rating: 80, new: true, set: "Bournemouth", gain: 180, first_owner: true, upgraded: false, new_first_owner: true },
  ],
};

// ?value: Best value from the real solver on real sets – with made-up prices (src-tauri test
// value_on_user_data, FCT_VALUE_FIXTURE=../src/devValue.json). Design only: fetched from the dev
// server, never bundled (not in git, never in the site demo).
let devValue: Promise<import("./api").BestValue | null> | null = null;
const loadDevValue = () =>
  (devValue ??=
    typeof location !== "undefined" && new URLSearchParams(location.search).has("value")
      ? fetch("/src/devValue.json").then((r) => (r.ok ? r.json() : null)).catch(() => null)
      : Promise.resolve(null));
// Left-out cards drop out of the fixture's buys (dev only – the real solver picks the next best card).
const dropOut = (v: import("./api").SetValue, out: number[]) => ({
  ...v,
  plans: v.plans.map((p) => ({ ...p, buys: p.buys.filter((b) => !out.includes(b.card.def_id)) })),
});
export const mockBestValue = async (_budget: number | null, _target: number | null, steps: number | null, out: number[] = []) => {
  const v = await loadDevValue();
  if (!v) return v;
  const plan = { ...v.plan, steps: v.plan.steps.slice(0, steps ?? undefined).map((s: import("./api").PlanStep) => ({ ...s, buys: s.buys.filter((b) => !out.includes(b.card.def_id)) })) };
  return { ...v, sets: v.sets.map((x: import("./api").SetValue) => dropOut(x, out)), plan };
};
export const mockSetValue = async (key: string, out: number[] = []) => {
  const v = (await loadDevValue())?.sets.find((s: import("./api").SetValue) => s.key === key);
  return v ? dropOut(v, out) : null;
};

// Champions (beta): the real weekend of a public FC 27 stream (championsExample.ts).
export const mockChampions: ChampsData = exampleChamps();
// the website demo: the weekend in progress while a Weekend League is on, otherwise nothing of its
// own – then the Champions tab shows the clock to the next one, how it works and the example
export const demoChampions = (): ChampsData => {
  const e = exampleChamps();
  return (e.runs[0].ends_at ?? 0) > Date.now() ? e : { runs: [], me: e.me, last_hub: null, pending: null };
};
export const mockChampionsEmpty: ChampsData = { runs: [], me: { gamertag: null, clubs: [], abbrs: [] }, last_hub: null, pending: null };
