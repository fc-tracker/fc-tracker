// Champions (beta): a real FC 27 weekend for the dev preview and the website demo – the user's own
// first Weekend League (23–26 Oct 2026): 12–3, the results in the order he played them, the last a
// DNF (the game crashed). No scores or opponents were read that weekend, so none are shown – nothing
// here is made up. The website demo shows it while a Weekend League is on (`?champs-live` forces it
// in the dev preview).
import { champsClock, type ChampsData, type ChampsMatch, type Outcome } from "./championsData";

const ORDER: Outcome[] = ["win", "win", "win", "win", "loss", "win", "win", "loss", "win", "win", "win", "win", "win", "win", "loss"];

export function exampleChamps(now = Date.now()): ChampsData {
  const clock = champsClock(null, now);
  const live = clock.live || (typeof location !== "undefined" && new URLSearchParams(location.search).has("champs-live"));
  // the weekend on now (Weekend League live), else the last one – so the clock never disagrees
  const ends = live ? (clock.live ? clock.ends : clock.ends) : clock.ends - 7 * 24 * 3_600_000;
  const t0 = Math.min(now, ends) - 40 * 3_600_000;
  const matches: ChampsMatch[] = ORDER.map((outcome, i) => ({
    started: t0 + i * 2_400_000, seen: t0 + i * 2_400_000 + 1_500_000, n: i + 1, outcome, confirmed: true, hub_only: true,
    home: { abbr: null, club: null, gamertag: null, record: null, est: null }, away: { abbr: null, club: null, gamertag: null, record: null, est: null },
    me_home: true, score: null, timeline: [], last: null, extra_time: false, disconnect: i === 14, paused_at: null, card_win: null, coins: null, sp: null,
  }));
  return {
    runs: [
      {
        id: t0,
        ends_at: ends,
        hub: { at: Math.min(now, ends), wins: 12, losses: 3, remaining: 0, points: null, rank: null, rank_pts: null, ends_at: ends },
        matches,
      },
    ],
    me: { gamertag: null, clubs: [], abbrs: [] },
    last_hub: null,
    pending: null,
  };
}
