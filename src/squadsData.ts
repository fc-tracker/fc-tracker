// Objective squads (SQUADS.md): the shape of `squads_plan` (src-tauri/src/squads.rs).

export interface SquadPrefs {
  /** 0–33: "as close to X as possible". */
  chem_target: number;
  /** Chemistry before the requirements. */
  chem_first: boolean;
  hide_loans: boolean;
  /** Most coins a suggested buy may cost; null = the user's coins. */
  budget: number | null;
  /** "Has to include": club cards (item ids) every squad plays. */
  must: number[];
  /** "Has to include" cards not owned yet (card definitions) – they play, marked "to get". */
  must_cards: number[];
  /** Objectives the user marked done (or not done) by hand; a newer sync replaces them. */
  done_marks: DoneMark[];
  /** "I'm playing …": the event the first session is built around; null = Auto. */
  primary: number | null;
  /** Where to play it; null = the best place. */
  place: Mode | null;
  /** "progress" (most objectives per match) | "buys" | "changes" | "matches". */
  goal: string;
  /** Most cards to buy for one squad; null = no limit, 0 = club only. */
  max_buys: number | null;
  /** A formation the user picked; null = the best. */
  formation: string | null;
  /** Follow the plan in the game (count matches, say when to change). */
  track: boolean;
  played: number;
  played_at: number;
  /** "Is it still available?" – the user's answers (lower-case names) … */
  skip: string[];
  keep: string[];
  /** … and what users established together. */
  facts: Record<string, boolean>;
  /** A bench player's own sub minute (club item id → minute). */
  sub_at?: Record<string, number>;
  /** Preferred formations (labels like "4-3-1-2" or EA names); empty = every formation. */
  formations?: string[];
  /** "balanced" (default) | "30" | "33" – replaces chem_target / chem_first in the UI. */
  chem_mode?: string;
  /** Club cards taken out of every squad ("Change" / "Leave out"). */
  exclude?: number[];
  /** "Change players" (user 2026-11-04): each card no longer stands at that position – FC-Tracker re-solves, the
   *  card is replaced or moves, the rest adapts. Never a "has to include" (squads.rs SwapOut). */
  swaps?: SwapOut[];
  /** The exact player picked for one position (user 2026-11-05): it plays there only; the rest re-solves (squads.rs pins). */
  pins?: SwapOut[];
  /** Reroll: 0 = the best squad, n = the n-th best formation's (squads.rs). */
  reroll?: number;
  /** A squad locked in for the coming challenges: these cards, this formation, until unlocked. */
  locked?: LockedSquad | null;
}

export interface LockedSquad {
  event: number;
  title: string;
  formation: string;
  keys: number[];
  at: number;
}

/** Where a match counts (squads.rs `Mode`). */
export type Mode =
  | { kind: "squad_battles" | "rivals" | "champions" | "rush" | "draft" | "co_op" | "live_events" | "any" }
  | { kind: "event"; name: string };

export const sameMode = (a: Mode | null | undefined, b: Mode | null | undefined) => !!a && !!b && a.kind === b.kind && (a.kind !== "event" || (b.kind === "event" && a.name === b.name));

export interface DoneMark {
  group: number;
  objective: number;
  done: boolean;
  /** Unix ms. */
  at: number;
}

export type Need =
  | { kind: "league" | "club" | "nation"; id: number }
  | { kind: "icon" | "hero" }
  | { kind: "rating" | "weak_foot" | "skill_moves" | "chemistry"; id: number }
  | { kind: "rarity"; id: number[] }
  | { kind: "accel"; id: string }
  | { kind: "playstyle"; id: [string, boolean] };

export interface ManagerView {
  league: number;
  league_name: string | null;
  nation: number;
  nation_name: string | null;
  /** Chemistry it adds over the squad's manager now. */
  gain: number;
  current: boolean;
}

export interface Stage {
  from: number;
  to: number | null;
  squad: SquadView;
  reqs: ReqView[];
  swaps: Swap[];
  finishing: string[];
}

export interface Swap {
  pos: string;
  out_name: string;
  in_name: string;
  in_rating: number;
  in_owned: boolean;
  in_price: number | null;
  nation: number;
  nation_name: string | null;
  league_name: string | null;
}

export interface GetOption {
  kind: "owned" | "reward" | "sbc" | "cheapest" | "value" | "upgrade" | "search";
  name: string;
  def_id: number;
  rating: number;
  pos: string;
  price: number | null;
  source: string | null;
  strength: number;
  nation: number;
  nation_name: string | null;
}

export interface ReqView {
  need: Need;
  name: string;
  count: number;
  have: number;
  met: boolean;
  players: string[];
  options: GetOption[];
  unpriced: number;
  /** Club cards that meet it (in the squad or not) and the first of them. */
  club: number;
  club_players: string[];
}

export interface ObjectiveView {
  id: number;
  name: string;
  text: string;
  progress: number;
  target: number;
  done: boolean;
  req: number | null;
  unknown: string | null;
  /** Done / not done by the user's own mark, not by the last sync. */
  marked: boolean;
  /** Moved on by playing matches. */
  playable: boolean;
}

export interface SlotView {
  /** Club item id, or the card definition for a card to get (older plans: missing – use def_id). */
  key?: number;
  pos: string;
  name: string;
  def_id: number;
  rating: number;
  chem: number;
  strength: number;
  loan: boolean;
  counts_for: number[];
  /** "explosive" | "controlled" | "lengthy" – known once the in-game attributes are read. */
  accel: string | null;
  /** PlayStyles that matter in this position (PlayStyles+ among them). */
  key_ps: number;
  key_ps_plus: number;
  /** Rated from the in-game attributes (else from the face stats). */
  full: boolean;
  /** EA's nation id (the flag). */
  nation: number;
  nation_name: string | null;
  /** Bio: 1 = right foot, 2 = left, 0 = unknown; weak foot and skill moves in stars. */
  foot: number;
  weak_foot: number;
  skill_moves: number;
  /** A "has to include" card. */
  must: boolean;
  /** First owner, proven (EA's mark on the card). */
  first_owner?: boolean;
  /** EA's art guid: a special's action shot. */
  art?: string | null;
  /** Not in the club yet (a "has to include" card to get) and its price. */
  owned: boolean;
  price: number | null;
  league: number;
  league_name: string | null;
  /** Out of its positions: 0 chemistry, it counts for a requirement. */
  out_of_position: boolean;
  /** To buy without a recent price: a profile to search for. */
  generic: boolean;
  /** In an active evolution (its name). */
  evo?: string | null;
  /** Face stats PAC SHO PAS DRI DEF PHY, the card's EA rarity, club and own positions (its art – older plans: missing). */
  face?: number[] | null;
  rareflag?: number | null;
  club?: number | null;
  positions?: string[];
}

export interface SquadView {
  formation: string;
  chem: number;
  chem_target: number;
  slots: SlotView[];
  strength: number;
  met: number;
  changes: number | null;
  /** "Has to include" cards that found no place in this squad. */
  must_missing: string[];
  buys: number;
  cost: number;
  manager: ManagerView | null;
}

export interface EventPlan {
  id: number;
  title: string;
  /** Unix seconds. */
  ends_at: number | null;
  done: number;
  total: number;
  objectives: ObjectiveView[];
  reqs: ReqView[];
  squad: SquadView | null;
  /** The session (`SessionPlan.id`) shown for this event. */
  combo: number | null;
  /** EA's category and its id (the Web App's order). */
  category: string;
  category_id: number | null;
  /** Ends within a season (not Foundations / Milestones / Mastery). */
  live: boolean;
  /** Has open objectives a match moves on. */
  playable: boolean;
}

/** One way to play now: a place, the XI for it and every open objective a match there moves on. */
export interface SessionPlan {
  id: number;
  place: Mode;
  /** A live event by its event's title; other places by their kind. */
  place_name: string;
  title: string;
  ends_at: number | null;
  reqs: ReqView[];
  items: SessionItem[];
  squad: SquadView | null;
  counted: number;
  /** Long-running objectives that move on too (free extras). */
  bonus: number;
  primary: number | null;
  /** The match plan: squads in turn (the first is `squad`). */
  stages: Stage[];
  /** Matches the app counted since the last read. */
  played: number;
  /** A squad for a few matches only: how many. */
  quick: number | null;
  /** Active evolutions a match here moves on too. */
  evos?: SessionEvo[];
  /** Club cards on the bench for objectives a sub does. */
  bench?: BenchPick[];
  /** The match brief: before the match in broad strokes, in the match who does what. */
  brief?: MatchBrief;
  /** Rush or a Rush live event: one player, no XI – `rush` is who to bring. */
  rush_format?: boolean;
  rush?: RushPick | null;
  /** The live event's entry rules the squad keeps to. */
  rules?: EntryRules | null;
  /** A live event whose entry rules aren't read yet: no squad suggested. */
  rules_unread?: boolean;
}

export interface EntryRules {
  min_rating: number | null;
  max_rating: number | null;
}

/** The one player to bring to Rush. */
export interface RushPick {
  key: number;
  name: string;
  pos: string;
  rating: number;
  nation: number;
  nation_name: string | null;
  owned: boolean;
  price: number | null;
  /** Not owned, no recent price: search the market for him. */
  generic: boolean;
  /** His evolution a match here moves on. */
  evo: string | null;
  /** The card itself (EA's art). Older plans: missing. */
  def_id?: number;
  rareflag?: number;
  league?: number;
  club?: number;
  positions?: string[];
  face?: number[] | null;
  first_owner?: boolean;
  art?: string | null;
}

export interface MatchBrief {
  before: { kind: "squad" | "ready" | "buy" | "use" | "bench" | "rush" | "rush_buy" | "rules" | "cap" | "unread"; text: string; count: number | null }[];
  players: { name: string; pos: string; bench: boolean; tasks: BriefTask[] }[];
  anyone: BriefTask[];
  /** Tasks with a requirement on the doer: one line each, who can do it inside (most suitable first). */
  reqs?: BriefTask[];
}

export interface BriefTask {
  text: string;
  left: number;
  /** The requirement the doer must meet (index into the session's reqs). */
  req?: number;
  who?: { name: string; pos: string; bench: boolean }[];
}

/** A club card on the bench: subbed on late, it counts for these objectives. */
export interface BenchPick {
  key: number;
  name: string;
  pos: string;
  rating: number;
  nation: number;
  nation_name: string | null;
  objectives: string[];
}

/** An active evolution in a session: subbed on, or starting when it needs him from the start. */
export interface SessionEvo {
  name: string;
  key: number;
  player: string;
  pos?: string;
  rating?: number;
  nation?: number;
  nation_name?: string | null;
  level: number;
  levels: number;
  goal: string;
  progress: number;
  target: number;
  start: boolean;
  in_xi: boolean;
  matches_left: number;
  days_left: number | null;
}

export interface SessionItem {
  event: number;
  event_title: string;
  objective: number;
  name: string;
  text: string;
  progress: number;
  target: number;
  req: number | null;
  unknown: string | null;
  /** The requirement is about who scores / assists. */
  scorer: boolean;
  counts: boolean;
  bonus: boolean;
  /** About how many matches it still takes (the user's own results). */
  matches: number | null;
  /** No card we know meets it: ask whether it's still available (lower case). */
  ask: string | null;
  /** Met by a card on the bench (subbed on late). */
  bench?: boolean;
}

export interface Apart {
  event: number;
  title: string;
  places: string[];
}

export interface PlaceOption {
  place: Mode;
  name: string;
  objectives: number;
}

export interface SquadsView {
  events: EventPlan[];
  /** Play sessions: the user's pick (or the most objectives) first. */
  combos: SessionPlan[];
  /** Events the first session can't play for. */
  apart: Apart[];
  /** Where the picked event can be played. */
  places: PlaceOption[];
  primary: number | null;
  needs_sync: boolean;
  names_missing: boolean;
  club_players: number;
  coins: number | null;
  read_at: number | null;
  prefs: SquadPrefs;
  /** The club, strongest first (the "has to include" list). */
  club: ClubEntry[];
}

export interface SwapOut {
  key: number;
  pos: string;
}

export interface ClubEntry {
  key: number;
  name: string;
  rating: number;
  positions: string[];
  nation: number;
  nation_name: string | null;
  loan: boolean;
  owned: boolean;
  /** EA's price (not owned, when known and recent). */
  price: number | null;
  /** FC-Tracker's meta rating per position the card can play. */
  meta?: Record<string, number>;
  /** The card itself (FUT card art). */
  def_id?: number;
  rareflag?: number;
  club?: number;
  league?: number;
  face?: number[] | null;
  /** EA's art guid: a special's action shot. */
  art?: string | null;
}

export const defaultSquadPrefs: SquadPrefs = { chem_target: 33, chem_first: false, hide_loans: true, budget: null, must: [], must_cards: [], done_marks: [], primary: null, place: null, goal: "progress", max_buys: 3, formation: null, track: true, played: 0, played_at: 0, skip: [], keep: [], facts: {}, formations: [], chem_mode: "balanced", exclude: [], swaps: [], locked: null };

export const emptySquads: SquadsView = { events: [], combos: [], apart: [], places: [], primary: null, needs_sync: true, names_missing: true, club_players: 0, coins: null, read_at: null, prefs: defaultSquadPrefs, club: [] };

/** Pitch rows, attack at the top. */
const LINES: string[][] = [["LW", "ST", "RW"], ["LM", "CAM", "RM"], ["CM"], ["CDM"], ["LB", "CB", "RB"], ["GK"]];

export function pitchRows(slots: SlotView[]): SlotView[][] {
  // where the wide midfielders stand is the formation's (user 2026-11-05: 4-4-1-1 (2) is 4 · 4 · CAM · ST): with two
  // central midfielders they make one line with them (4-4-2, 4-4-1-1, 4-1-4-1); with three centre backs and two CDMs
  // with them (3-5-2); otherwise on the CAM line (4-2-3-1)
  const n = (p: string) => slots.filter((x) => x.pos === p).length;
  const wideWith = n("CM") >= 2 ? "CM" : n("CDM") === 2 && n("CB") === 3 ? "CDM" : "CAM";
  const lines = LINES.map((line) => (wideWith === "CAM" ? line : line.filter((p) => p !== "LM" && p !== "RM"))).map((line) =>
    line.includes(wideWith) && wideWith !== "CAM" ? ["LM", ...line, "RM"] : line,
  );
  return lines.map((line) =>
    slots
      .filter((s) => line.includes(s.pos))
      .sort((a, b) => line.indexOf(a.pos) - line.indexOf(b.pos)),
  ).filter((r) => r.length > 0);
}
