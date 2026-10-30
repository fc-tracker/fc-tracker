// Champions (beta): the Weekend League the way the game's own hub shows it – the record (wins,
// losses, matches left) and the clock on top, the 15-rank ladder with its rewards, and a slot for
// each of the 15 matches: played ones with result, score, opponent and goal minutes, the rest still
// to play. Nothing invented: before the user's first match the slots are empty and the guide says
// how it fills. The same view in the app overlay and on FC-Tracker Web (where matches are read by
// the app – the strip says so).
import { useEffect, useState, type ReactNode } from "react";
import { api, events, IS_WEB } from "./api";
import {
  champsClock, emptyChamps, goals, rankFor, RANK_TIERS, RANKS, REWARDS, shownScore, sides, weekendStats,
  type Clock, type ChampsData, type ChampsMatch, type ChampsRun,
} from "./championsData";
import { compact, num } from "./format";
import { BOARD_PAGE, boardName, fetchBoard, markChampsTabSeen, setChampsNewsState, type Board } from "./championsBoard";
import { t, type MessageKey } from "./i18n";

const SLOTS = 15;

export function useChampions(): ChampsData | null {
  const [data, setData] = useState<ChampsData | null>(null);
  useEffect(() => {
    let alive = true;
    api.championsData().then((d) => alive && setData(d)).catch(() => alive && setData(emptyChamps));
    const un = events.onChampions((d) => setData(d));
    return () => {
      alive = false;
      un.then((u) => u());
    };
  }, []);
  return data;
}

/** Whether the tracker is switched on (it ships off); null while loading. Enter / the south button
 *  in the overlay switches it on (the "fct:champions-switch" event); the overlay hears the state
 *  back ("fct:champions-state") for its footer. */
function useChampsOn(): [boolean | null, () => void] {
  const [on, setOn] = useState<boolean | null>(null);
  const switchOn = () =>
    api
      .setChampionsTracking(true)
      .then((p) => {
        setOn(p.champions === true);
        setChampsNewsState("done");
      })
      .catch(() => {});
  useEffect(() => {
    markChampsTabSeen();
    if (IS_WEB) return;
    api.uiPrefs().then((p) => setOn(p.champions === true)).catch(() => setOn(null));
    const onSwitch = () => switchOn();
    window.addEventListener("fct:champions-switch", onSwitch);
    return () => window.removeEventListener("fct:champions-switch", onSwitch);
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("fct:champions-state", { detail: on }));
  }, [on]);
  return [on, switchOn];
}

/** Re-renders every `ms` so the clock counts down while the view is open. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return t("champs.time.dh", { d, h: pad(h) });
  if (h > 0) return t("champs.time.hm", { h, m: pad(m % 60) });
  return t("champs.time.m", { m: m % 60 });
}

/** The clock: to the end of the Weekend League on now (with how much of it is gone), else to the next. */
function ClockBox({ clock, now }: { clock: Clock; now: number }) {
  const label: MessageKey = clock.live ? (clock.exact ? "champs.clock.ends" : "champs.clock.endsAbout") : "champs.clock.opens";
  const gone = clock.live ? Math.min(1, Math.max(0, (now - clock.opens) / Math.max(1, clock.ends - clock.opens))) : null;
  return (
    <div className={`ch-clock ${clock.live ? "live" : ""}`} role="timer">
      <small>
        {clock.live && <span className="ch-live-dot" aria-hidden="true" />}
        {t(label)}
      </small>
      <b>{span((clock.live ? clock.ends : clock.opens) - now)}</b>
      {gone != null ? (
        <span className="ch-clock-bar" aria-hidden="true">
          <i style={{ width: `${gone * 100}%` }} />
        </span>
      ) : null}
      <span>{t(clock.exact ? "champs.clock.fromGame" : "champs.clock.usual")}</span>
    </div>
  );
}

/** Wins · losses · left – big, like the hub's three boxes. */
function Record({ wins, losses, left }: { wins: number; losses: number; left: number }) {
  return (
    <div className="ch-rec" aria-label={t("champs.recordLabel", { wins, losses, left })}>
      <div className="w">
        <b>{wins}</b>
        <small>{t("champs.wins")}</small>
      </div>
      <div className="l">
        <b>{losses}</b>
        <small>{t("champs.losses")}</small>
      </div>
      <div>
        <b>{left}</b>
        <small>{t("champs.leftShort")}</small>
      </div>
    </div>
  );
}

/** The 15 ranks in three tiers: the ones reached filled, the next one lit with its reward. */
function Ladder({ wins }: { wins: number }) {
  const next = wins < 15 ? wins + 1 : null;
  const reward = (w: number) => {
    const r = REWARDS[w - 1];
    return r.coins ? t("champs.ladder.reward", { coins: compact(r.coins), tokens: r.tokens }) : t("champs.ladder.tokens", { tokens: r.tokens });
  };
  return (
    <section className="ch-ladder" aria-label={t("champs.ladder.title")}>
      <header>
        <p className="eyebrow">{t("champs.ladder.title")}</p>
        <p className="ch-ladder-now">
          {wins > 0 ? (
            <>
              <b>{rankFor(wins)}</b> · {reward(wins)}
            </>
          ) : (
            t("champs.ladder.none")
          )}
          {next && (
            <span className="ch-ladder-next">
              {t("champs.ladder.next", { rank: rankFor(next) ?? "", wins: next })} · {reward(next)}
            </span>
          )}
        </p>
      </header>
      <ol className="ch-tiers">
        {RANK_TIERS.map((tier, ti) => (
          <li key={tier} className={`ch-tier t${ti}`}>
            <span className="ch-tier-name">{tier}</span>
            <ol>
              {RANKS.slice(ti * 5, ti * 5 + 5).map((rank, i) => {
                const w = ti * 5 + i + 1;
                const state = w <= wins ? "got" : w === next ? "next" : "";
                return (
                  <li key={rank} className={`ch-rung ${state}`} title={`${rank} · ${reward(w)}`}>
                    <span className="ch-rung-gem" aria-hidden="true" />
                    <b>{rank.split(" ")[1]}</b>
                    <small>{t("champs.ladder.winsN", { count: w })}</small>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
      <p className="ch-ladder-note">{t("champs.ladder.note")}</p>
    </section>
  );
}

/** Goal minutes on a 90' (or 120') line: above = scored, below = conceded. */
function Timeline({ m }: { m: ChampsMatch }) {
  const gs = goals(m);
  if (!gs.length) return null;
  const end = m.extra_time || gs.some((g) => g.minute > 90) ? 120 : 90;
  return (
    <div className="ch-line" aria-label={t("champs.goalMinutes")}>
      <span className="ch-line-half" style={{ left: `${(45 / end) * 100}%` }} />
      {end > 90 && <span className="ch-line-half et" style={{ left: `${(90 / end) * 100}%` }} />}
      {gs.map((g, i) => (
        <span key={i} className={`ch-goal ${g.forMe ? "for" : "against"}`} style={{ left: `${(Math.min(g.minute, end) / end) * 100}%` }} title={`${g.minute}'`} />
      ))}
    </div>
  );
}

/** One of the 15 matches: played (result, score, opponent, notes, goal minutes), in play, or to come. */
function Slot({ n, m, live }: { n: number; m?: ChampsMatch; live?: boolean }) {
  if (!m) {
    return (
      <li className="ch-slot open">
        <span className="ch-slot-n">{n}</span>
        <span className="ch-slot-todo">{t("champs.slot.todo")}</span>
      </li>
    );
  }
  const { opp } = sides(m);
  const s = shownScore(m);
  const o = live ? "live" : m.outcome ?? "open";
  return (
    <li className={`ch-slot ${o}`}>
      <span className="ch-slot-n">{n}</span>
      <span className="ch-slot-out">{live ? t("champs.live") : m.outcome ? t(`champs.short.${m.outcome}`) : "…"}</span>
      {s.score ? (
        <b className="ch-slot-score">
          {s.score[0]}–{s.score[1]}
          {m.extra_time && <small> {t("champs.aet")}</small>}
        </b>
      ) : null}
      {opp.club || opp.abbr ? (
        <span className="ch-slot-opp">
          {opp.club ?? opp.abbr}
          {opp.record ? <small> · {t("champs.oppRecord", { wins: opp.record[0], losses: opp.record[1] })}</small> : null}
        </span>
      ) : (
        <span className="ch-slot-opp quiet">{m.hub_only ? t("champs.notSeen") : t("champs.unknownOpp")}</span>
      )}
      {(m.disconnect || s.whenLeft || (!m.confirmed && !live && !m.hub_only)) && (
        <span className="ch-slot-note">
          {m.disconnect ? t("champs.dnf") : s.whenLeft ? t("champs.whenLeft", { score: `${s.whenLeft[0]}–${s.whenLeft[1]}`, minute: s.minute ?? 0 }) : t("champs.unconfirmed")}
        </span>
      )}
      <Timeline m={m} />
    </li>
  );
}

/** The 15 slots in order of play; a match the hub hasn't numbered yet takes the next free one. */
function Slots({ run, pending }: { run: ChampsRun | undefined; pending: ChampsMatch | null }) {
  const at: (ChampsMatch | undefined)[] = Array(SLOTS).fill(undefined);
  for (const m of run?.matches ?? []) {
    const i = m.n && m.n >= 1 && m.n <= SLOTS && !at[m.n - 1] ? m.n - 1 : at.findIndex((x) => !x);
    if (i >= 0) at[i] = m;
  }
  const liveAt = pending ? at.findIndex((x) => !x) : -1;
  return (
    <section className="ch-slots-wrap">
      <p className="eyebrow">{t("champs.matches")}</p>
      <ol className="ch-slots">
        {at.map((m, i) => (i === liveAt ? <Slot key={i} n={i + 1} m={pending!} live /> : <Slot key={i} n={i + 1} m={m} />))}
      </ol>
    </section>
  );
}

/** The weekend's numbers – only the ones there is something to say about. */
function Stats({ run }: { run: ChampsRun }) {
  const s = weekendStats(run);
  const scored = run.matches.some((m) => shownScore(m).score);
  const kpis: [string, MessageKey][] = [];
  if (scored) kpis.push([`${s.goalsFor}–${s.goalsAgainst}`, "champs.goals"]);
  if (s.comebacks) kpis.push([String(s.comebacks), "champs.comebacks"]);
  if (s.lateConceded) kpis.push([String(s.lateConceded), "champs.late"]);
  if (s.extraTime) kpis.push([String(s.extraTime), "champs.extraTime"]);
  if (s.quits) kpis.push([String(s.quits), "champs.quits"]);
  if (s.oppStrength != null) kpis.push([`${Math.round(s.oppStrength * 100)} %`, "champs.oppStrength"]);
  const streak = (() => {
    let best = 0;
    let cur = 0;
    for (const o of s.form) {
      cur = o === "win" ? cur + 1 : 0;
      best = Math.max(best, cur);
    }
    return best;
  })();
  if (streak >= 2) kpis.unshift([String(streak), "champs.streak"]);
  if (s.played >= 3) kpis.unshift([`${Math.round((s.wins / s.played) * 100)} %`, "champs.winRate"]);
  const max = Math.max(1, ...s.blocks.map((b) => Math.max(b.for, b.against)));
  const labels = ["0'", "15'", "30'", "45'", "60'", "75'", "ET"];
  if (!kpis.length && !s.blocks.some((b) => b.for + b.against > 0)) return null;
  return (
    <aside className="ch-stats">
      <p className="eyebrow">{t("champs.weekend")}</p>
      <div className="ch-kpis">
        {kpis.map(([v, k]) => (
          <div key={k}>
            <b>{v}</b>
            <span>{t(k)}</span>
          </div>
        ))}
      </div>
      {s.blocks.some((b) => b.for + b.against > 0) && (
        <>
          <p className="ch-sub">{t("champs.byTime")}</p>
          <div className="ch-bars" role="img" aria-label={t("champs.byTime")}>
            {s.blocks.map((b, i) => (
              <div key={i} className="ch-bar">
                <span className="for" style={{ height: `${(b.for / max) * 100}%` }} title={`${b.for}`} />
                <span className="against" style={{ height: `${(b.against / max) * 100}%` }} title={`${b.against}`} />
                <small>{labels[i]}</small>
              </div>
            ))}
          </div>
          <p className="ch-legend">
            <span className="for" /> {t("champs.scored")} <span className="against" /> {t("champs.conceded")}
          </p>
        </>
      )}
    </aside>
  );
}

/** Where the user stands on the weekly leaderboard (opt-in), or how to join it. */
function BoardCard() {
  const name = boardName();
  const [board, setBoard] = useState<Board | null>(null);
  useEffect(() => {
    fetchBoard(!!name).then(setBoard);
  }, [name]);
  const open = () => (IS_WEB ? window.open(BOARD_PAGE, "_blank", "noopener") : api.openSite(BOARD_PAGE).catch(() => {}));
  return (
    <aside className="ch-board">
      <p className="eyebrow">{t("champs.board.title")}</p>
      {name ? (
        <p>{board?.me ? <b>{t("champs.board.pos", { pos: board.me.pos, players: num(board.players) })}</b> : t("champs.board.waiting", { name })}</p>
      ) : (
        <p>{t(IS_WEB ? "champs.board.joinWeb" : "champs.board.join")}</p>
      )}
      {board && board.players > 0 && !board.me && (
        <p className="ch-board-n">{t(board.players === 1 ? "champs.board.player" : "champs.board.players", { players: num(board.players) })}</p>
      )}
      <button className="theme-btn" onClick={open}>
        {t("champs.board.open")}
      </button>
    </aside>
  );
}

/** Earlier weekends: record, rank, date. */
function History({ runs }: { runs: ChampsRun[] }) {
  if (!runs.length) return null;
  return (
    <section className="ch-history">
      <p className="eyebrow">{t("champs.history")}</p>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            <b>
              {r.hub.wins}–{r.hub.losses}
            </b>
            <span>{rankFor(r.hub.wins) ?? ""}</span>
            <small>{new Date(r.id).toLocaleDateString()}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How it works – four steps, none of them a button to press in the game. */
function Guide({ on }: { on: boolean | null }) {
  return (
    <section className="ch-guide">
      <p className="eyebrow">{t("champs.how.title")}</p>
      <ol className="ch-how">
        {(["1", "2", "3", "4"] as const).map((n) => (
          <li key={n} className={n === "1" && on ? "done" : ""}>
            <span className="bv-how-n">{n === "1" && on ? "✓" : n}</span>
            <div>
              <b>{t(`champs.how.${n}Title` as MessageKey)}</b>
              <span>{t(`champs.how.${n}${n === "1" && IS_WEB ? "Web" : ""}` as MessageKey)}</span>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function Champions({ keys }: { keys?: ReactNode }) {
  const data = useChampions();
  const [on, switchOn] = useChampsOn();
  const now = useNow();
  if (!data && !IS_WEB) return <div className="ch"><p className="ml-loading">{t("champs.loading")}</p></div>;
  const own = IS_WEB ? emptyChamps : data ?? emptyChamps;
  const last = own.runs[own.runs.length - 1];
  const clock = champsClock(own, now);
  // this weekend's run (its hub has time left, or a match is in play); otherwise a fresh weekend
  const pending = own.pending && (own.pending.last || own.pending.score || own.pending.home.abbr) ? own.pending : null;
  const current = last && last.ends_at && last.ends_at > now ? last : undefined;
  const hub = current?.hub ?? null;
  const wins = hub?.wins ?? 0;
  const losses = hub?.losses ?? 0;
  const left = hub ? hub.remaining : SLOTS;
  const playing = !!current || !!pending;
  const earlier = own.runs.filter((r) => r !== current).reverse();
  const status = IS_WEB
    ? t("champs.status.web")
    : on === false
      ? t("champs.status.off")
      : playing
        ? t(wins + losses === 0 ? "champs.status.ready" : "champs.status.counting")
        : t("champs.status.on");
  return (
    <div className="ch">
      <header className="ch-hero">
        <div className="ch-title">
          <p className="eyebrow">
            {t("section.champions")} · {t("champs.beta")}
          </p>
          <h1 className="detail-title">{t("champs.title")}</h1>
          <p className="detail-sub">
            <span className={`ch-on ${IS_WEB ? "web" : on ? "on" : on === false ? "off" : ""}`} aria-hidden="true" />
            {status}
          </p>
        </div>
        <Record wins={wins} losses={losses} left={left} />
        <ClockBox clock={clock} now={now} />
      </header>

      {IS_WEB ? (
        <div className="ch-strip">
          <span className="ch-strip-mark" aria-hidden="true" />
          <p>
            <b>{t("champs.strip.webTitle")}</b> {t("champs.webOnly")}
          </p>
          <a className="theme-btn ch-strip-btn" href="/download" target="_blank" rel="noopener">
            {t("champs.strip.getApp")}
          </a>
        </div>
      ) : on === false ? (
        <div className="ch-strip">
          <span className="ch-strip-mark" aria-hidden="true" />
          <p>
            <b>{t("champs.strip.title")}</b> {t("champs.strip.text")}
          </p>
          <button className="theme-btn ch-strip-btn" onClick={switchOn}>
            {keys} {t("champs.news.switch")}
          </button>
        </div>
      ) : null}

      <Ladder wins={wins} />

      <div className="ch-grid">
        <Slots run={current} pending={pending} />
        <div className="ch-side">
          {current && current.matches.length > 0 ? <Stats run={current} /> : <Guide on={on} />}
          <BoardCard />
        </div>
      </div>

      <History runs={earlier} />
      <p className="ch-privacy">{t("champs.privacy")}</p>
    </div>
  );
}
