// Champions leaderboard (opt-in, beta): the user's own weekend record under a name he picks, sent
// to fc-tracker.com/api/champions after the hub counts a match (site/api/champions.mjs). Nothing
// else – never an opponent, never a gamertag read from the screen. Off until a name is set.
import type { ChampsData } from "./championsData";
import { goals, shownScore } from "./championsData";
import { installId } from "./usage";

const API = "https://www.fc-tracker.com/api/champions";
export const BOARD_PAGE = "https://www.fc-tracker.com/fc-27-champions-leaderboard";
const NAME_KEY = "fct.champs.board";
const SENT_KEY = "fct.champs.sent";
export const NAME_RE = /^[\p{L}\p{N} _.-]{3,16}$/u;

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {}
};

/** The tracker's announcement (it ships switched off): "open" until switched on or put off. */
export type ChampsNews = "open" | "later" | "done";
export const champsNewsState = (): ChampsNews => {
  const v = get("fct.champs.news");
  return v === "later" || v === "done" ? v : "open";
};
export const setChampsNewsState = (v: ChampsNews) => set("fct.champs.news", v);
/** The overlay tab says "New" until the Champions tab has been opened once. */
export const champsTabSeen = () => get("fct.champs.seen") === "1";
export const markChampsTabSeen = () => set("fct.champs.seen", "1");

/** The name shown on the leaderboard; null = not taking part. */
export const boardName = () => get(NAME_KEY);
export function setBoardName(name: string | null) {
  set(NAME_KEY, name && NAME_RE.test(name.trim()) ? name.trim() : null);
  set(SENT_KEY, null);
}

/** Sends the current weekend if it changed since the last upload (and the user takes part). */
export async function uploadWeekend(d: ChampsData): Promise<void> {
  const name = boardName();
  const run = d.runs[d.runs.length - 1];
  if (!name || !run?.hub || !run.ends_at) return;
  // every match as the player saw it – outcome, his score, extra time, a lost connection and the
  // goal minutes; never the opponent
  const matches = run.matches
    .filter((m) => m.n != null && m.outcome)
    .map((m) => {
      const s = shownScore(m);
      return {
        n: m.n,
        r: m.outcome === "win" ? "w" : m.outcome === "quit" ? "q" : "l",
        s: m.outcome === "quit" ? null : s.score,
        et: m.extra_time,
        dnf: m.disconnect,
        g: goals(m).map((g) => [g.minute, g.forMe ? 1 : 0]),
      };
    });
  // the goal totals only when every counted match's score was read (else they would be too low)
  const complete = matches.length === run.hub.wins + run.hub.losses && matches.every((m) => m.s || m.r === "q");
  let gf: number | null = complete ? 0 : null;
  let ga: number | null = complete ? 0 : null;
  if (complete) {
    for (const m of matches) {
      if (m.s) {
        gf! += m.s[0];
        ga! += m.s[1];
      }
    }
  }
  const body = { id: installId(), name, platform: "pc", ends_at: run.ends_at, wins: run.hub.wins, losses: run.hub.losses, gf, ga, rank: run.hub.rank, matches };
  const key = JSON.stringify([name, run.ends_at, body.wins, body.losses, gf, ga, body.rank, matches]);
  if (get(SENT_KEY) === key) return;
  try {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });
    if (r.ok) set(SENT_KEY, key);
  } catch {}
}

export interface BoardRow {
  pos: number;
  name: string;
  platform: "pc" | "console";
  wins: number;
  losses: number;
  gf: number;
  ga: number;
  rank: string | null;
}
export interface Board {
  event: string | null;
  events: string[];
  players: number;
  top: BoardRow[];
  wins: number[];
  me?: { pos: number } | null;
}

export async function fetchBoard(withMe: boolean): Promise<Board | null> {
  try {
    const r = await fetch(`${API}${withMe ? `?me=${encodeURIComponent(installId())}` : ""}`);
    return r.ok ? ((await r.json()) as Board) : null;
  } catch {
    return null;
  }
}
