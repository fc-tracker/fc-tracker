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

// ?view=toast&demo=… : every lower-third of mockup 08 with the user's own data (his Therkildsen evo,
// his club of 198, his Champions weekend at 12–2 after match 14, Paradela TOTW 80 proven first owner,
// his plan's changes after match 4). Design only; `&secs=8` draws the timer line.
export const mockToasts: Record<string, ToastPayload> = {
  evo: { kind: "match-reminder", at: 0, needs: [{ player: "Therkildsen", evo: "Intro to Evolutions", level: 3, levels: 3, start: false, bench: false, at: 70 }] },
  remind: { kind: "match-reminder", at: 70, now: true, needs: [{ player: "Therkildsen", evo: "Intro to Evolutions", level: 3, levels: 3, start: false, bench: false, at: 70 }] },
  "sync-club": { kind: "sync", state: "running", phase: "club", count: 120 },
  synced: { kind: "sync", state: "done", count: 198 },
  "sync-stopped": { kind: "sync", state: "aborted" },
  "no-extension": { kind: "sync", state: "login", reason: "no_extension" },
  win: { kind: "champions", n: 14, outcome: "win", score: null, when_left: null, minute: null, aet: false, opponent: null, wins: 12, losses: 2, remaining: 1 },
  fo: { kind: "pack", regrade: false, first_owner: true, cards: [{ def_id: 245354, name: "Paradela", rating: 80, new: false, set: "TOTW", gain: 0, first_owner: true, upgraded: true, new_first_owner: false }] },
  m5: { kind: "squads-swap", played: 4, swaps: [{ pos: "CM", out: "LaBonta", in: "João Neves", buy: false }, { pos: "CM", out: "Paradela", in: "Musiala", buy: false }] },
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

// Objective squads: the real plan the engine made from the user's club for the FC Heritage Circuit
// events (squads.rs `real_club_heritage_events`, FCT_SQUADS_OUT → src/squadsDemo.json).
import type { ClubEntry, SquadPrefs, SquadsView } from "./squadsData";
import squadsDemo from "./squadsDemo.json";
// ?squads-gaps: the same club with two leagues left out – shows the realistic options (design only)
import squadsGaps from "./squadsGapsDemo.json";
let squadPrefs: SquadPrefs | null = null;
export const mockSquads = (): SquadsView => {
  const gaps = typeof location !== "undefined" && new URLSearchParams(location.search).has("squads-gaps");
  const v = (gaps ? squadsGaps : squadsDemo) as unknown as SquadsView;
  // the demo plan predates the match brief: the user's real Rivals brief (2026-11-02) stands in (design only)
  const combos = v.combos?.map((c, i) => (i > 0 || c.brief ? c : { ...c, brief: MOCK_BRIEF, evos: c.evos?.length ? c.evos : MOCK_EVOS }));
  // card art (rareflag) the demo predates, from the demo's own Gallery cards (design only)
  const art = (c: (typeof combos)[number]) => (c.squad ? { ...c, squad: { ...c.squad, slots: c.squad.slots.map((sl) => ({ ...sl, rareflag: (sl as { rareflag?: number }).rareflag ?? mockRarity.get(sl.def_id) })) } } : c);
  // the ?squads-gaps fixture predates sessions (no combos / apart / places): an empty plan, never a crash
  // the demo club predates ClubEntry.meta / def_id / rareflag (the app sends them): the engine's own per-position
  // strength from the demo plans' slots, matched by name and rating (design only – real values, nothing invented)
  const slots = [...(v.combos ?? []).flatMap((c) => [c.squad, ...(c.stages ?? []).map((st) => st.squad)]), ...(v.events ?? []).map((e) => e.squad)]
    .filter((q): q is NonNullable<typeof q> => !!q)
    .flatMap((q) => q.slots);
  const club = (v.club ?? []).map((c) => {
    const mine = slots.filter((sl) => sl.name === c.name && sl.rating === c.rating);
    if (!mine.length || c.meta) return c;
    const meta: Record<string, number> = {};
    for (const sl of mine) meta[sl.pos] = Math.max(meta[sl.pos] ?? 0, sl.strength);
    return { ...c, meta, def_id: c.def_id ?? mine[0].def_id, rareflag: c.rareflag ?? mockRarity.get(mine[0].def_id) };
  });
  return { ...v, club, combos: combos?.map(art) ?? [], apart: v.apart ?? [], places: v.places ?? [], read_at: Date.now() - 12 * 60_000, prefs: squadPrefs ?? v.prefs };
};
// the user's own active evolutions (his screenshots 2026-11-04: Rakneberg Creep Inside 2/4, Therkildsen
// Intro to Evolutions 3/3), on the bench – the side panel's Evolutions section and next sub (design only)
const MOCK_EVOS: NonNullable<SquadsView["combos"][number]["evos"]> = [
  { name: "Intro to Evolutions", key: 954620486623, player: "Therkildsen", pos: "RB", rating: 65, nation: 13, level: 3, levels: 3, goal: "play", progress: 0, target: 2, start: false, in_xi: false, matches_left: 2, days_left: 6 },
  { name: "Creep Inside", key: 954642120801, player: "Rakneberg", pos: "LB", rating: 65, nation: 36, level: 2, levels: 4, goal: "play", progress: 0, target: 1, start: false, in_xi: false, matches_left: 3, days_left: 5 },
];
const MOCK_BRIEF: NonNullable<SquadsView["combos"][number]["brief"]> = {
  before: [
    { kind: "squad", text: "4-3-1-2", count: 8 },
    { kind: "buy", text: "Herrera · CB", count: null },
    { kind: "buy", text: "Hernández · LB", count: null },
    { kind: "buy", text: "Paradela · CM", count: 10500 },
    { kind: "use", text: "Mexico National team Away kit", count: null },
    { kind: "use", text: "Ghoul Fest Animated TIFO", count: null },
    { kind: "bench", text: "Therkildsen, Suhonen", count: null },
  ],
  players: [
    { name: "Adeyemi", pos: "ST", bench: false, tasks: [{ text: "Score 10 goals", left: 10 }, { text: "Assist at least 1 goal in 7 separate matches", left: 7 }, { text: "Score at least 1 goal in 13 separate matches", left: 13 }, { text: "Score at least one Chip Shot goal in 5 separate matches", left: 3 }, { text: "Score 10 headers", left: 3 }] },
    { name: "Mandžukić", pos: "ST", bench: false, tasks: [{ text: "Score 4 goals", left: 4 }] },
  ],
  // a requirement on the doer (4★ weak foot): a requirement line, who can do it in this XI (attackers first) inside
  reqs: [{ text: "Score at least 1 goal from outside the box in 10 separate matches", left: 2, req: 8, who: [{ name: "Musiala", pos: "LM", bench: false }, { name: "Debinha", pos: "CAM", bench: false }, { name: "Dallmann", pos: "RM", bench: false }, { name: "Oberdorf", pos: "CM", bench: false }] }],
  anyone: [{ text: "Keep a clean sheet", left: 1 }, { text: "Win 3 matches", left: 3 }, { text: "Win 6 matches", left: 6 }, { text: "Win 10 matches", left: 10 }, { text: "Score 2 goals", left: 2 }, { text: "Win 1 match", left: 1 }],
};
// the demo has no catalog: the cards the demo plan suggests stand in for a search
export const mockSquadsSearch = (q: string): ClubEntry[] => {
  const opts = (squadsGaps as unknown as SquadsView).events.flatMap((e) => e.reqs.flatMap((r) => r.options));
  const w = q.toLowerCase();
  return opts
    .filter((o) => o.name.toLowerCase().includes(w))
    .map((o) => ({ key: o.def_id, name: o.name, rating: o.rating, positions: [o.pos], nation: o.nation, nation_name: o.nation_name, loan: false, owned: false, price: o.price }));
};
export const setMockSquadPrefs = (p: SquadPrefs) => {
  squadPrefs = p;
  return { mode: "panel" as const, missing_side: "left" as const, after_play: "remind" as const, squads: p };
};

// Dev preview only: the user's own FC 27 screenshot behind the overlay (in the app FC 27 itself is behind the
// transparent window). Local file (design/d-draft-2/img, gitignored) – absent elsewhere, then nothing shows.
if (import.meta.env.DEV && typeof document !== "undefined" && import.meta.env.MODE !== "web") {
  document.documentElement.style.setProperty("--game", "url(/design/d-draft-2/img/ingame-future-stars.jpg)");
}
// ---- the account, offline (dev preview only: ?view=launcher&mock=account-out | account-code | account-in | account-conflict).
// account.ts routes its API calls here; any 6-digit code signs in. A sample user, not a real one.
import type { Conflict, Device, User } from "./account";
export const mockAccountUser: User = {
  id: "mock",
  email: "player@example.com",
  username: "SamplePlayer",
  ea_name: null,
  show_ea: false,
  display_name: "SamplePlayer",
  locale: "en",
  created_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
  avatar_url: null,
};
let mockDevices: Device[] = [
  { id: "d1", name: "FC-Tracker app · Windows", kind: "app", version: "0.1.101", created_at: new Date(Date.now() - 20 * 86_400_000).toISOString(), last_seen: new Date().toISOString(), this: true },
  { id: "d2", name: "FC-Tracker Web · Chrome", kind: "web", created_at: new Date(Date.now() - 6 * 86_400_000).toISOString(), last_seen: new Date(Date.now() - 2 * 86_400_000).toISOString(), this: false },
];
export const mockAccountConflicts = (): Conflict[] => [
  { part: "gallery", cloudAt: Date.now() - 35 * 60_000, cloudDevice: "FC-Tracker Web · Chrome", localAt: Date.now() - 3 * 3_600_000 },
  { part: "settings", cloudAt: Date.now() - 2 * 86_400_000, cloudDevice: "FC-Tracker Web · Chrome", localAt: Date.now() - 10 * 60_000 },
];
let mockShares: { id: string; kind: string; data: unknown; created_at: string; views: number }[] = [];
export async function mockAccountCall(method: string, path: string, body?: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 450)); // every wait shows its notice
  const b = (body ?? {}) as Record<string, unknown>;
  if (path === "/v1/auth/start") return {};
  if (path === "/v1/auth/verify") {
    if (!/^\d{6}$/.test(String(b.code ?? "").replace(/\s/g, ""))) throw "code_invalid";
    return { access: "mock", refresh: "mock", expires_in: 3600, user: mockAccountUser };
  }
  if (path === "/v1/auth/refresh") return { access: "mock", refresh: "mock", expires_in: 3600 };
  if (path === "/v1/auth/logout") return {};
  if (path === "/v1/auth/handoff") return { code: "M".repeat(43), expires_in: 60 };
  if (path === "/v1/auth/handoff/redeem") {
    if (b.code !== "M".repeat(43)) throw "handoff_invalid";
    return { access: "mock", refresh: "mock", expires_in: 3600, user: mockAccountUser };
  }
  if (path === "/v1/me" && method === "GET") return mockAccountUser;
  if (path === "/v1/me" && method === "PATCH") return Object.assign(mockAccountUser, b, { display_name: (b.show_ea ? mockAccountUser.ea_name : (b.username as string) ?? mockAccountUser.username) ?? mockAccountUser.display_name });
  if (path === "/v1/me" && method === "DELETE") return {};
  if (path === "/v1/me/devices") return { devices: mockDevices };
  if (path.startsWith("/v1/me/devices/")) {
    mockDevices = mockDevices.filter((d) => !path.endsWith(d.id));
    return {};
  }
  if (path === "/v1/me/export") return { user: mockAccountUser, devices: mockDevices, note: "sample export (dev preview)" };
  if (path === "/v1/sync") return { parts: {} };
  // share links (dev preview): kept in memory
  if (path === "/v1/share" && method === "POST") {
    const id = Math.random().toString(36).slice(2, 12);
    mockShares.unshift({ id, kind: "squad", data: b.data, created_at: new Date().toISOString(), views: 0 });
    return { id };
  }
  if (path === "/v1/me/shares") return { shares: mockShares.map((s) => ({ id: s.id, kind: s.kind, title: (s.data as { title?: string })?.title ?? null, created_at: s.created_at, views: s.views })) };
  if (path.startsWith("/v1/share/") && method === "DELETE") {
    mockShares = mockShares.filter((s) => !path.endsWith(s.id));
    return { ok: true };
  }
  // the share page's sample (`share.html?mock=account-in&id=sample`): the first objective session of the sample plan
  if (path === "/v1/share/sample") {
    const { sharePayload } = await import("./share/payload");
    const s = mockSquads().combos.find((c) => c.squad);
    if (!s) throw "not_found";
    return { id: "sample", kind: "squad", data: sharePayload(s), created_at: new Date().toISOString(), by: mockAccountUser.username, views: 12 };
  }
  if (path.startsWith("/v1/share/")) {
    const s = mockShares.find((x) => path.endsWith(x.id));
    if (!s) throw "not_found";
    return { ...s, by: mockAccountUser.username, views: ++s.views };
  }
  return {};
}

// the demo plan predates the cards' art fields: EA's rarity per card definition, from the same real demo's Gallery
export const mockRarity: Map<number, number> = new Map(
  (demo.overview as unknown as GalleryCategory[]).flatMap((c) => c.sets.flatMap((s) => [...s.lineup, ...s.top_missing])).filter((c) => c.rareflag != null).map((c) => [c.def_id, c.rareflag as number]),
);

// Players (dev preview): the sample Gallery's cards, marks and removals kept in memory
const mockMarks = new Map<number, boolean | null>();
const mockRemoved = new Set<number>();
export const mockSetFirstOwner = (defId: number, value: boolean | null) => void mockMarks.set(defId, value);
export const mockSetRemoved = (defId: number, removed: boolean) => void (removed ? mockRemoved.add(defId) : mockRemoved.delete(defId));
export function mockGalleryCards(): import("./api").CardRow[] {
  const rows = new Map<number, import("./api").CardRow>();
  for (const c of mockGallery) for (const s of c.sets) for (const x of s.lineup) {
    if (!x.name || x.def_id > 1e15) continue;
    const r = rows.get(x.def_id) ?? { def_id: x.def_id, name: x.name, rating: x.rating, position: x.position, positions: [], rareflag: x.rareflag, nation: x.nation ?? null, league: x.league ?? null, club: x.club ?? null, face: x.face, art: x.art ?? null, score: x.score, holo: x.holo, first_owner: x.first_owner as import("./api").CardRow["first_owner"], removed: false, sets: [] };
    r.sets.push(s.name);
    const mark = mockMarks.get(x.def_id);
    if (mark === true) r.first_owner = "manual";
    if (mark === false) r.first_owner = "manual_no";
    r.removed = mockRemoved.has(x.def_id);
    rows.set(x.def_id, r);
  }
  return [...rows.values()].sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
}
