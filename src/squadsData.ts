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
  | { kind: "rating" | "weak_foot" | "skill_moves" | "chemistry" | "rarity"; id: number }
  | { kind: "accel"; id: string }
  | { kind: "playstyle"; id: [string, boolean] };

export interface GetOption {
  kind: "owned" | "reward" | "sbc" | "cheapest" | "value" | "upgrade";
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
}

export interface SlotView {
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
  /** Not in the club yet (a "has to include" card to get) and its price. */
  owned: boolean;
  price: number | null;
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
  primary: number | null;
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
}

export const defaultSquadPrefs: SquadPrefs = { chem_target: 33, chem_first: false, hide_loans: true, budget: null, must: [], must_cards: [], done_marks: [], primary: null, place: null };

export const emptySquads: SquadsView = { events: [], combos: [], apart: [], places: [], primary: null, needs_sync: true, names_missing: true, club_players: 0, coins: null, read_at: null, prefs: defaultSquadPrefs, club: [] };

/** Pitch rows, attack at the top. */
const LINES: string[][] = [["LW", "ST", "RW"], ["LM", "CAM", "RM"], ["CM"], ["CDM"], ["LB", "CB", "RB"], ["GK"]];

export function pitchRows(slots: SlotView[]): SlotView[][] {
  return LINES.map((line) =>
    slots
      .filter((s) => line.includes(s.pos))
      .sort((a, b) => line.indexOf(a.pos) - line.indexOf(b.pos)),
  ).filter((r) => r.length > 0);
}
