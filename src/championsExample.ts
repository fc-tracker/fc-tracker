// Champions (beta): one real FC 27 weekend as the tracker reads it – the matches of a public FC 27
// stream (Nice SC; results, clubs and opponents' records as shown on the result cards). Goal
// minutes are not in it: the stream never showed every goal, and nothing here is made up.
// Opponents' gamertags are left out (they are personal data and never shown outside the user's PC).
// Shown as the labelled example in the Champions view until the user's own weekend is read, and
// served by the dev mock.
import { champsClock, type ChampsData, type ChampsMatch } from "./championsData";

const team = (abbr: string | null, club: string, record: [number, number] | null = null) => ({ abbr, club, gamertag: null, record, est: null });

export function exampleChamps(now = Date.now()): ChampsData {
  // the weekend on now (Weekend League live), else the last one – so the clock never disagrees
  const clock = champsClock(null, now);
  const ends = clock.live ? clock.ends : clock.ends - 7 * 24 * 3_600_000;
  const t0 = Math.min(now, ends) - 3 * 3_600_000;
  const match = (n: number, over: Partial<ChampsMatch>): ChampsMatch => ({
    started: t0 + n * 1_500_000, seen: t0 + n * 1_500_000 + 900_000, n, outcome: "win", confirmed: true, hub_only: false,
    home: team("NIC", "Nice SC"), away: team(null, "Opponent"), me_home: true, score: null, timeline: [], last: null,
    extra_time: false, disconnect: false, paused_at: null, card_win: null, coins: null, sp: null, ...over,
  });
  return {
    runs: [
      {
        id: t0,
        ends_at: ends,
        hub: { at: Math.min(now, ends), wins: 1, losses: 2, remaining: 12, points: 1, rank: "Contender IV", rank_pts: [1, 2], ends_at: ends },
        matches: [
          match(1, { away: team(null, "Class on Grass", [6, 6]), score: [6, 0], coins: 941, sp: 64 }),
          match(2, { outcome: "loss", home: team("NS5", "NS105", [3, 0]), away: team("NIC", "Nice SC"), me_home: false, score: [5, 4], sp: 15 }),
          match(3, { outcome: "loss", away: team(null, "Basprovol", [1, 0]), score: [4, 5], extra_time: true, sp: 24 }),
        ],
      },
    ],
    me: { gamertag: null, clubs: ["Nice SC"], abbrs: ["NIC"] },
    last_hub: null,
    pending: null,
  };
}
