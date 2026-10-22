// Champions tracker (beta): the data the app reads from Champions matches (src-tauri/src/champions.rs)
// and what the weekend view computes from it. Opponent gamertags stay on this PC – they are shown
// only here, never sent anywhere.

export type Outcome = "win" | "loss" | "quit";

export interface ChampsHub {
  at: number;
  wins: number;
  losses: number;
  remaining: number;
  points: number | null;
  rank: string | null;
  rank_pts: [number, number] | null;
  ends_at: number | null;
}

export interface ChampsTeam {
  abbr: string | null;
  club: string | null;
  gamertag: string | null;
  record: [number, number] | null;
  est: string | null;
}

export interface ChampsMatch {
  started: number;
  seen: number;
  n: number | null;
  outcome: Outcome | null;
  confirmed: boolean;
  hub_only: boolean;
  home: ChampsTeam;
  away: ChampsTeam;
  me_home: boolean | null;
  score: [number, number] | null;
  timeline: [number, number, number][];
  last: [number, number, number] | null;
  extra_time: boolean;
  disconnect: boolean;
  paused_at: number | null;
  card_win: boolean | null;
  coins: number | null;
  sp: number | null;
}

export interface ChampsRun {
  id: number;
  ends_at: number | null;
  hub: ChampsHub;
  matches: ChampsMatch[];
}

export interface ChampsData {
  runs: ChampsRun[];
  me: { gamertag: string | null; clubs: string[]; abbrs: string[] };
  last_hub: ChampsHub | null;
  pending: ChampsMatch | null;
}

export const emptyChamps: ChampsData = { runs: [], me: { gamertag: null, clubs: [], abbrs: [] }, last_hub: null, pending: null };

/** The user's side first: [me, opponent] (home first while the side isn't known). */
export function sides(m: ChampsMatch): { me: ChampsTeam; opp: ChampsTeam; known: boolean } {
  const home = m.me_home ?? true;
  return { me: home ? m.home : m.away, opp: home ? m.away : m.home, known: m.me_home != null };
}

/** [goals for, goals against] from a [home, away] pair. */
export function mine(m: ChampsMatch, pair: [number, number] | null): [number, number] | null {
  if (!pair) return null;
  return (m.me_home ?? true) ? [pair[0], pair[1]] : [pair[1], pair[0]];
}

/** The score to show: the final one, else (a quit) the forfeit 0-3 with the score when left. */
export function shownScore(m: ChampsMatch): { score: [number, number] | null; whenLeft: [number, number] | null; minute: number | null } {
  const last = m.last ? mine(m, [m.last[1], m.last[2]]) : null;
  if (m.outcome === "quit") return { score: [0, 3], whenLeft: last, minute: m.last ? m.last[0] : null };
  return { score: mine(m, m.score) ?? (m.hub_only ? null : last), whenLeft: null, minute: null };
}

export interface Goal {
  minute: number;
  forMe: boolean;
}

/** Goals in minute order from the score timeline. */
export function goals(m: ChampsMatch): Goal[] {
  const out: Goal[] = [];
  let prev: [number, number] = [0, 0];
  for (const [minute, h, a] of m.timeline) {
    const homeScored = h > prev[0];
    const meHome = m.me_home ?? true;
    out.push({ minute, forMe: homeScored === meHome });
    prev = [h, a];
  }
  return out;
}

export interface WeekendStats {
  played: number;
  wins: number;
  losses: number;
  quits: number;
  extraTime: number;
  goalsFor: number;
  goalsAgainst: number;
  /** goals for / against per 15 minutes: 0–15 … 75–90, 90+ (extra time) */
  blocks: { for: number; against: number }[];
  lateConceded: number;
  comebacks: number;
  /** average win share of the opponents' records (when shown) */
  oppStrength: number | null;
  form: Outcome[];
}

export function weekendStats(run: ChampsRun): WeekendStats {
  const ms = run.matches;
  const blocks = Array.from({ length: 7 }, () => ({ for: 0, against: 0 }));
  let goalsFor = 0;
  let goalsAgainst = 0;
  let lateConceded = 0;
  let comebacks = 0;
  const strengths: number[] = [];
  for (const m of ms) {
    const s = shownScore(m);
    if (s.score && m.outcome !== "quit") {
      goalsFor += s.score[0];
      goalsAgainst += s.score[1];
    }
    let behind = false;
    let lead = [0, 0];
    for (const g of goals(m)) {
      const b = Math.min(6, Math.floor(g.minute / 15));
      if (g.forMe) {
        blocks[b].for++;
        lead[0]++;
      } else {
        blocks[b].against++;
        lead[1]++;
        if (g.minute >= 80) lateConceded++;
      }
      if (lead[0] < lead[1]) behind = true;
    }
    if (behind && m.outcome === "win") comebacks++;
    const opp = sides(m).opp.record;
    if (opp && opp[0] + opp[1] > 0) strengths.push(opp[0] / (opp[0] + opp[1]));
  }
  return {
    played: ms.length,
    wins: ms.filter((m) => m.outcome === "win").length,
    losses: ms.filter((m) => m.outcome === "loss" || m.outcome === "quit").length,
    quits: ms.filter((m) => m.outcome === "quit").length,
    extraTime: ms.filter((m) => m.extra_time).length,
    goalsFor,
    goalsAgainst,
    blocks,
    lateConceded,
    comebacks,
    oppStrength: strengths.length ? strengths.reduce((a, b) => a + b, 0) / strengths.length : null,
    form: ms.filter((m) => m.outcome).map((m) => m.outcome!) ,
  };
}

// ---- the Weekend League clock
const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
/** A Weekend League runs Friday 19:00 → Monday 08:00 UK time (61 h, most published FC 27 schedules). */
const WINDOW = 61 * HOUR;

/** London wall-clock offset from UTC right now (GMT or BST), in ms. */
function londonOffset(at: number): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(at))
    .reduce<Record<string, string>>((o, x) => ((o[x.type] = x.value), o), {});
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return wall - Math.floor(at / 60_000) * 60_000;
}

export type Clock = { live: boolean; ends: number; opens: number; exact: boolean };

/** When the current Weekend League ends, or when the next one opens. The game's own timer when the
 *  hub was read (this weekend, or a past one + whole weeks); else the usual schedule, as "about". */
export function champsClock(data: ChampsData | null, now: number): Clock {
  const hubEnds = [data?.last_hub?.ends_at, ...(data?.runs ?? []).map((r) => r.ends_at ?? r.hub.ends_at)].filter((x): x is number => !!x);
  const known = hubEnds.length ? Math.max(...hubEnds) : null;
  // a hub read with time left = the event is on (the game's own timer)
  if (known && known > now) return { live: true, ends: known, opens: known - WINDOW, exact: true };
  if (known) {
    const ends = known + Math.ceil((now - known) / WEEK) * WEEK;
    return { live: now >= ends - WINDOW, ends, opens: ends - WINDOW, exact: false };
  }
  // next Monday 08:00 London after now; the window opened 61 h before it
  const off = londonOffset(now);
  const wall = new Date(now + off);
  const toMonday = (8 - wall.getUTCDay()) % 7;
  let ends = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + toMonday, 8) - off;
  if (ends <= now) ends += WEEK;
  return { live: now >= ends - WINDOW, ends, opens: ends - WINDOW, exact: false };
}

