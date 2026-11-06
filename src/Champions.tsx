// Champions (beta, mockup 05): the Weekend League the way the game's own hub shows it. Left: the record
// (12–3), the rank the wins earn with its rewards, Played · Win rate · Best run · DNF, "Weekend complete" or
// "One more win", the rank row, how it was counted and the tracker switch with the privacy lines. Middle:
// "YOUR WEEKEND." – the 15 results as a strip, a table with the rank reached and the running W–L, win runs,
// the next weekend, tiers reached and the record line. Right: the rank ladder with coins + tokens per rank;
// an opened match takes its place (PRINCIPLES 16a). Nothing invented: what was not read says so. Opponents'
// names, tags and clubs are never shown (they stay on this PC). The same view in the app and on FC-Tracker Web.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, events, IS_WEB } from "./api";
import {
  champsClock, emptyChamps, goals, rankFor, RANK_TIERS, RANKS, REWARDS, shownScore, sides,
  type ChampsData, type ChampsMatch, type ChampsRun,
} from "./championsData";
import { num } from "./format";
import { markChampsTabSeen, setChampsNewsState } from "./championsBoard";
import { Coin, Keycap, Rank, Score, Switch, Token } from "./ui";
import { getLocale, t, type MessageKey } from "./i18n";

const SLOTS = 15;
const HOUR = 3_600_000;

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

/** Whether the tracker is switched on (it ships off); null while loading. ✕/A switches it on while it is
 *  off, △/Y (and the switch) toggles it; the overlay hears the state back ("fct:champions-state") for its footer. */
function useChampsOn(): [boolean | null, (on: boolean) => void] {
  const [on, setOn] = useState<boolean | null>(null);
  const set = (v: boolean) =>
    api
      .setChampionsTracking(v)
      .then((p) => {
        setOn(p.champions === true);
        if (p.champions) setChampsNewsState("done");
      })
      .catch(() => {});
  useEffect(() => {
    markChampsTabSeen();
    if (IS_WEB) return;
    api.uiPrefs().then((p) => setOn(p.champions === true)).catch(() => setOn(null));
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("fct:champions-state", { detail: on }));
  }, [on]);
  return [on, set];
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

/** a date and time that never breaks across lines ("Mon, Nov 9" stays together) */
const when = (ms: number) => new Date(ms).toLocaleString(getLocale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(/\s/g, " ");

/** "23–26 Oct 2026": the weekend's days (it opens 61 h before it ends). */
export function weekendLabel(run: ChampsRun): string {
  const ends = run.ends_at ?? run.hub.ends_at;
  if (!ends) return new Date(run.id).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" });
  const opens = new Date(ends - 61 * HOUR);
  const end = new Date(ends - 1);
  const sameMonth = opens.getMonth() === end.getMonth();
  const a = opens.toLocaleDateString(getLocale(), sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  return `${a}–${end.toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" })}`;
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

/** A match in the weekend's order, with the hub's count after it. */
type Played = { n: number; m: ChampsMatch; win: boolean; dnf: boolean; w: number; l: number };

/** The 15 slots in order of play; a match the hub hasn't numbered yet takes the next free one. */
function slotsOf(run: ChampsRun | undefined): (ChampsMatch | undefined)[] {
  const at: (ChampsMatch | undefined)[] = Array(SLOTS).fill(undefined);
  for (const m of run?.matches ?? []) {
    const i = m.n && m.n >= 1 && m.n <= SLOTS && !at[m.n - 1] ? m.n - 1 : at.findIndex((x) => !x);
    if (i >= 0) at[i] = m;
  }
  return at;
}

function playedOf(at: (ChampsMatch | undefined)[]): (Played | null)[] {
  let w = 0;
  let l = 0;
  return at.map((m, i) => {
    if (!m || !m.outcome) return null;
    const win = m.outcome === "win";
    if (win) w++;
    else l++;
    return { n: i + 1, m, win, dnf: m.disconnect || m.outcome === "quit", w, l };
  });
}

/** Runs of 2+ wins in a row: [first match, last match]. */
function winRuns(ps: (Played | null)[]): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  ps.forEach((p, i) => {
    const won = !!p?.win;
    if (won && !from) from = i + 1;
    const ends = !won || i === ps.length - 1;
    if (from && ends) {
      const to = won ? i + 1 : i;
      if (to - from + 1 >= 2) out.push([from, to]);
      from = 0;
    }
  });
  return out;
}

/** One match, opened in place of the rank ladder (PRINCIPLES 16a): what was read, and "Not read" where nothing was. */
function MatchDetail({ p, onBack }: { p: Played; onBack: () => void }) {
  const { m, n } = p;
  const s = shownScore(m);
  const { opp } = sides(m);
  const gs = goals(m);
  const nr = <span className="md-nr">{t("v2.md.notRead")}</span>;
  const unread = !s.score || !gs.length;
  const r = REWARDS[p.w - 1];
  return (
    <section className="md panel ring ch5-side" aria-label={t("v2.md.title", { n })}>
      {/* the frame never scrolls itself (§16): a short window scrolls the detail inside it */}
      <div className="frame-scroll md-body">
      <header className="md-hd">
        <span className="eyebrow">{t("v2ov.matchOf", { n: String(n).padStart(2, "0") })}</span>
        <button className="md-back btn btn-quiet btn-s" onClick={onBack}>
          <Keycap ps="○" xb="B" kb="Esc" label={t("v2.md.back")} />
        </button>
      </header>
      <div className="md-top">
        <span className={`md-res ${p.win ? "" : "l"}`}>{t(`champs.short.${m.outcome ?? "loss"}` as MessageKey)}</span>
        <span className="md-sc">{s.score ? <Score a={s.score[0]} b={s.score[1]} className="num-l" /> : nr}</span>
      </div>
      <dl className="md-kv">
        <div className="md-r">
          <dt>{t("v2ov.afterMatch")}</dt>
          <dd>
            <b className="num">{p.w}</b> W · <b className="num">{p.l}</b> L
          </dd>
        </div>
        <div className="md-r">
          <dt>{t("v2ov.rankReached")}</dt>
          <dd className="md-rank">
            {p.w > 0 ? (
              <>
                <Rank i={p.w - 1} got size="s" name={RANKS[p.w - 1]} /> {RANKS[p.w - 1]}
              </>
            ) : (
              "–"
            )}
          </dd>
        </div>
        <div className="md-r">
          <dt>{t("v2ov.rankRewards")}</dt>
          <dd>
            {r ? (
              <>
                {r.coins > 0 && (
                  <>
                    <Coin /> <b className="num">{num(r.coins)}</b>{" "}
                  </>
                )}
                <Token /> <b className="num">{r.tokens}</b>
              </>
            ) : (
              "–"
            )}
          </dd>
        </div>
      </dl>
      <div className="md-sec">
        <span className="eyebrow">{t("v2.md.goals")}</span>
        {gs.length ? <Timeline m={m} /> : <div className="md-line empty" aria-hidden="true" />}
      </div>
      <dl className="md-kv">
        <div className="md-r">
          <dt>{t("v2.md.opponent")}</dt>
          <dd>{opp.record ? t("champs.oppRecord", { wins: opp.record[0], losses: opp.record[1] }) : opp.club || opp.abbr ? t("v2.ch.oppRead") : nr}</dd>
        </div>
        <div className="md-r">
          <dt>{t("v2.md.played")}</dt>
          <dd>{!m.hub_only && m.started > 0 ? when(m.started) : nr}</dd>
        </div>
        <div className="md-r">
          <dt>{t("v2ov.howEnded")}</dt>
          <dd className={p.dnf ? "md-warn" : ""}>
            {p.dnf ? t("champs.dnf") : s.whenLeft ? t("champs.whenLeft", { score: `${s.whenLeft[0]}–${s.whenLeft[1]}`, minute: s.minute ?? 0 }) : m.extra_time ? t("champs.aet") : m.hub_only ? nr : t("v2ov.fullTime")}
          </dd>
        </div>
        <div className="md-r">
          <dt>{t("v2ov.matchCoins")}</dt>
          <dd>{m.coins != null ? <><Coin /> <b className="num">{num(m.coins)}</b></> : nr}</dd>
        </div>
      </dl>
      <p className="md-why">
        <i className="dot" />
        {unread ? t("v2.md.why") : t("v2ov.oppPrivate")}
      </p>
      </div>
    </section>
  );
}

/** The rank ladder: 15 ranks top-down with Season 1's coins and tokens, the current rank marked. */
function Ladder({ wins, done }: { wins: number; done: boolean }) {
  return (
    <section className="panel ring ch5-side ch5-ladder" aria-label={t("champs.ladder.title")}>
      <header>
        <span className="col">
          <span className="sec-t">{t("champs.ladder.title")}</span>
          <span className="ch5-muted">{t("v2ov.seasonRewards")}</span>
        </span>
        <span className="ch5-lad-legend">
          <span>
            <Coin /> {t("v2ov.coins")}
          </span>
          <span>
            <Token /> {t("v2ov.tokensCol")}
          </span>
        </span>
      </header>
      <div className="ch5-lad">
        {RANKS.map((name, i) => ({ name, i }))
          .reverse()
          .map(({ name, i }) => (
            <div key={name} className={`ch5-rung ${i < wins ? "got" : ""} ${i === wins - 1 ? "now" : ""} ${i === 4 || i === 9 ? "tier" : ""}`}>
              <span className="w num">{i + 1}</span>
              <Rank i={i} got={i < wins} next={done ? i === wins - 1 : i === wins} size="s" name={name} />
              <span className="nm">{name}</span>
              <span className="c num">{REWARDS[i].coins ? num(REWARDS[i].coins) : "–"}</span>
              <span className="tk num">{REWARDS[i].tokens}</span>
            </div>
          ))}
      </div>
    </section>
  );
}

/** Wins after each match as a step line, the two tier lines, a tick on each loss. */
function RecordChart({ ps }: { ps: (Played | null)[] }) {
  const W = 260;
  const H = 200;
  const X = (i: number) => i * (W / SLOTS);
  const Y = (v: number) => H - 8 - v * ((H - 30) / SLOTS);
  let d = `M0 ${Y(0)}`;
  const ticks: ReactNode[] = [];
  let last = 0;
  ps.forEach((p, i) => {
    if (!p) return;
    if (p.win) d += ` V${Y(p.w)} H${X(i + 1)}`;
    else {
      d += ` H${X(i + 1)}`;
      ticks.push(<line key={i} x1={X(i + 0.5)} x2={X(i + 0.5)} y1={Y(p.w) + 4} y2={Y(p.w) + 14} className="ch5-tick" />);
    }
    last = p.w;
  });
  const tier = (v: number, label: string, right: boolean) => (
    <g key={label}>
      <line x1="0" x2={W} y1={Y(v)} y2={Y(v)} className="ch5-tierline" vectorEffect="non-scaling-stroke" />
      <text x={right ? W - 2 : 2} y={right ? Y(v) + 15 : Y(v) - 5} textAnchor={right ? "end" : "start"} className="ch5-tiertext">
        {label}
      </text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t("v2ov.recordLabel", { wins: last, played: ps.filter(Boolean).length })}>
      {tier(5, t("v2ov.tierAt", { tier: RANK_TIERS[1], count: 6 }), true)}
      {tier(10, t("v2ov.tierAt", { tier: RANK_TIERS[2], count: 11 }), false)}
      {ticks}
      <path d={d} className="ch5-path" vectorEffect="non-scaling-stroke" />
      {ps.some(Boolean) && (
        <text x={W - 2} y={Y(last) - 6} textAnchor="end" className="ch5-endtext">
          {last}
        </text>
      )}
    </svg>
  );
}

/** How it works – four steps, none of them a button to press in the game (before the first weekend). */
function Guide({ on }: { on: boolean | null }) {
  return (
    <section className="panel ring ch5-guide">
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

export default function Champions(_props: { keys?: ReactNode }) {
  const data = useChampions();
  const [on, setTracking] = useChampsOn();
  const now = useNow();
  const own = data ?? emptyChamps;
  const runs = own.runs;
  const last = runs[runs.length - 1];
  const current = last && last.ends_at && last.ends_at > now ? last : undefined;
  const pending = own.pending && (own.pending.last || own.pending.score || own.pending.home.abbr) ? own.pending : null;
  // newest first: this weekend while it runs (or a match is in play), then the finished ones – the view
  // opens on the newest one that has data, never on an empty weekend (L2/R2 step through them)
  const order: (ChampsRun | null)[] = useMemo(() => {
    const done = runs.filter((r) => r !== current).reverse();
    return current ? [current, ...done] : pending ? [null, ...done] : done;
  }, [runs, current, pending]);
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const step = (e: Event) => setIdx((i) => Math.max(0, Math.min(order.length - 1, i + (e as CustomEvent<number>).detail)));
    window.addEventListener("fct:champions-weekend", step);
    return () => window.removeEventListener("fct:champions-weekend", step);
  }, [order.length]);
  const shown = order[Math.min(idx, order.length - 1)] ?? undefined;
  const live = !!shown && shown === current;
  const at = useMemo(() => slotsOf(shown), [shown]);
  const ps = useMemo(() => playedOf(at), [at]);
  const liveAt = live || (!shown && pending) ? (pending ? at.findIndex((x) => !x) : -1) : -1;
  const lastPlayed = ps.reduce((a, p, i) => (p ? i : a), -1);
  // the game cursor walks the 15 matches; an opened match replaces the ladder and follows the focus
  const [focus, setFocus] = useState<number>(-1);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setFocus(lastPlayed >= 0 ? lastPlayed : 0);
    setOpen(false);
  }, [shown?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const back = () => setOpen(false);
    window.addEventListener("fct:champions-back", back);
    return () => window.removeEventListener("fct:champions-back", back);
  }, []);
  const root = useRef<HTMLDivElement>(null);
  const nav = useRef<(a: string) => void>(() => {});
  nav.current = (a: string) => {
    if (a === "left" || a === "up") setFocus((f) => Math.max(0, f - 1));
    else if (a === "right" || a === "down") setFocus((f) => Math.min(SLOTS - 1, f + 1));
    else if (a === "brief") on != null && !IS_WEB && setTracking(!on);
    else if (a === "select" && ps[focus]) setOpen((o) => !o);
  };
  useEffect(() => {
    const h = (e: Event) => nav.current((e as CustomEvent<string>).detail);
    window.addEventListener("fct:view-nav", h);
    return () => window.removeEventListener("fct:view-nav", h);
  }, []);
  if (!data && !IS_WEB) return <div className="ov-empty"><p className="ml-loading">{t("champs.loading")}</p></div>;

  const hub = shown?.hub ?? null;
  const wins = hub?.wins ?? ps.filter((p) => p?.win).length;
  const losses = hub?.losses ?? ps.filter((p) => p && !p.win).length;
  const played = wins + losses;
  const rank = wins > 0 ? rankFor(wins) : null;
  const reward = wins > 0 ? REWARDS[wins - 1] : null;
  const runsW = winRuns(ps);
  const best = runsW.reduce<[number, number] | null>((a, r) => (!a || r[1] - r[0] > a[1] - a[0] ? r : a), null);
  const bestLen = best ? best[1] - best[0] + 1 : ps.some((p) => p?.win) ? 1 : 0;
  const dnfs = ps.filter((p): p is Played => !!p?.dnf);
  const lossAt = ps.filter((p): p is Played => !!p && !p.win).map((p) => p.n);
  const ended = !!shown && !live;
  const complete = played >= SLOTS || (ended && played > 0);
  const tierAt = (w: number) => ps.find((p) => p?.win && p.w === w)?.n ?? null;
  const clock = champsClock(own, now);
  const counted = ps.filter((p) => p?.m.confirmed).length;
  const fullRead = ps.filter((p) => p && !p.m.hub_only).length;
  const fp = ps[focus] ?? null;
  // the Weekend League clock: to the end of the one on now, else to the next (the game's timer when the hub was read)
  const clockBox = (
    <div className="panel ring ch5-box">
      <span className="sec-t">{clock.live ? t("v2ov.endsIn") : t("v2ov.nextWeekend")}</span>
      <span className="num ch5-cd">{span((clock.live ? clock.ends : clock.opens) - now)}</span>
      <span className="ch5-muted">{t(clock.exact ? "v2ov.opensEnds" : "v2ov.opensEndsAbout", { opens: when(clock.opens), ends: when(clock.ends) })}</span>
    </div>
  );

  return (
    <div className="ov-body ch5" ref={root}>
      <section className="panel ring xl ch5-hero">
        <div className="frame-scroll ch5-hero-body">
        <div className="ch5-row">
          <span className="eyebrow">
            {t("champs.title")} · {shown ? weekendLabel(shown) : t("v2ov.thisWeekend")}
          </span>
          <span className="ch5-row-r">
            {order.length > 1 && (
              <span className="ch5-step">
                <button className="btn btn-quiet btn-s" disabled={idx >= order.length - 1} onClick={() => setIdx((i) => Math.min(order.length - 1, i + 1))} aria-label={t("v2ov.olderWeekend")}>
                  ‹
                </button>
                <span className="num">
                  {Math.min(idx, order.length - 1) + 1}/{order.length}
                </span>
                <button className="btn btn-quiet btn-s" disabled={idx <= 0} onClick={() => setIdx((i) => Math.max(0, i - 1))} aria-label={t("v2ov.newerWeekend")}>
                  ›
                </button>
              </span>
            )}
            <span className="chip beta ring">{t("champs.beta")}</span>
          </span>
        </div>
        <div className="ch5-board">
          <Score a={wins} b={losses} className="ch5-score" />
          <div className="ch5-board-r">
            <span className="eyebrow">{t("v2.ch.rankFromWins")}</span>
            {rank ? (
              <>
                <span className="ch5-rank">
                  <Rank i={wins - 1} got size="m" name={rank} />
                  <span className="h2">{rank}</span>
                </span>
                {reward && (
                  <span className="ch5-rew">
                    {reward.coins > 0 && (
                      <span>
                        <Coin /> <b className="num">{num(reward.coins)}</b>
                      </span>
                    )}
                    <span>
                      <Token /> <b className="num">{reward.tokens}</b> {t("v2.tokens")}
                    </span>
                  </span>
                )}
              </>
            ) : (
              <span className="ch5-muted">{t("champs.ladder.none")}</span>
            )}
          </div>
        </div>
        <div className="ch5-kv">
          <div>
            <span className="eyebrow">{t("v2ov.played")}</span>
            <b className="num">
              {played}
              <small>/{SLOTS}</small>
            </b>
          </div>
          <div>
            <span className="eyebrow">{t("champs.winRate")}</span>
            <b className="num">
              {played ? Math.round((100 * wins) / played) : 0}
              <small>%</small>
            </b>
          </div>
          <div>
            <span className="eyebrow">{t("v2ov.bestRun")}</span>
            <b className="num">{bestLen}</b>
            {best && <small className="ch5-muted">{t("v2ov.matchesRange", { a: best[0], b: best[1] })}</small>}
          </div>
          <div>
            <span className="eyebrow">{t("v2ov.dnf")}</span>
            <b className="num">{dnfs.length}</b>
            {dnfs.length > 0 && <small className="ch5-muted">{t(dnfs.length === 1 ? "v2ov.matchN" : "v2ov.matchesN", { n: dnfs.map((p) => p.n).join(" · ") })}</small>}
          </div>
        </div>
        {complete && rank && reward ? (
          <div className="block cut ch5-done">
            <Rank i={wins - 1} got size="m" name={rank} />
            <span className="col">
              <span className="eyebrow done-text">{t("v2ov.weekendComplete")}</span>
              <span className="h4">
                {rank} · <Score a={wins} b={losses} />
              </span>
            </span>
            <span />
            <span className="ch5-rew">
              <span className="ch5-muted">{t("v2ov.rewardsEarned")}</span>
              {reward.coins > 0 && (
                <span>
                  <Coin /> <b className="num">{num(reward.coins)}</b>
                </span>
              )}
              <span>
                <Token /> <b className="num">{reward.tokens}</b> {t("v2.tokens")}
              </span>
            </span>
          </div>
        ) : !complete && wins < SLOTS && played < SLOTS ? (
          <div className="block cut ch5-next">
            <span className="eyebrow">{t("v2ov.oneMoreWin")}</span>
            <span />
            <span className="h4 ch5-rank">
              <Rank i={wins} next size="s" name={RANKS[wins]} />
              {RANKS[wins]} · <span className="ch5-muted">{t("v2ov.winsN", { count: wins + 1 })}</span>
            </span>
            <span className="ch5-rew">
              {REWARDS[wins].coins - (reward?.coins ?? 0) > 0 && (
                <span>
                  <Coin /> <b className="num">+{num(REWARDS[wins].coins - (reward?.coins ?? 0))}</b>
                </span>
              )}
              <span>
                <Token /> <b className="num">+{REWARDS[wins].tokens - (reward?.tokens ?? 0)}</b> {t("v2.tokens")}
              </span>
            </span>
          </div>
        ) : null}
        <div className="ch5-prog">
          <div className="ch5-row">
            <span className="eyebrow">{t("v2ov.rankProgress")}</span>
            <span className="ch5-muted">{t("v2ov.winsOf", { wins })}</span>
          </div>
          {/* the game's row of 15: a finished weekend puts the ▼ on the rank it ended on */}
          <div className="rk-row">
            {RANKS.map((name, i) => (
              <Rank key={name} i={i} got={i < wins} next={complete ? i === wins - 1 : i === wins} name={name} />
            ))}
          </div>
          <div className="ch5-tiers">
            {RANK_TIERS.map((x) => (
              <span key={x}>{x}</span>
            ))}
          </div>
        </div>
        {played > 0 && (
          <div className="ch5-how">
            <span className="eyebrow">{t("v2ov.howCounted")}</span>
            <div className="ch5-row">
              <span className="ch5-muted">{t("v2ov.fromHub")}</span>
              <b className="num">
                {counted}/{played}
              </b>
            </div>
            {fullRead > 0 && (
              <div className="ch5-row">
                <span className="ch5-muted">{t("v2ov.fromResult")}</span>
                <b className="num">{fullRead}</b>
              </div>
            )}
            <div className="ch5-row">
              <span className="ch5-muted">{lossAt.length ? t("v2ov.lossesAt", { n: lossAt.join(" · ") }) : t("v2ov.losses")}</span>
              <b className="num">{losses}</b>
            </div>
            <div className="ch5-row">
              <span className="ch5-muted">{t("v2ov.didNotFinish")}</span>
              <b className="num">{dnfs.length}</b>
            </div>
            {shown?.corrected && <p className="ch-corrected">{t("champs.corrected")}</p>}
          </div>
        )}
        <div className="ch5-tracker">
          <div className="hr" />
          {IS_WEB ? (
            <div className="ch5-row">
              <span className="ch5-muted">{t("champs.webOnly")}</span>
              <a className="btn btn-secondary ring btn-s" href="/download" target="_blank" rel="noopener">
                {t("champs.strip.getApp")}
              </a>
            </div>
          ) : (
            <div className="ch5-row">
              <span className="ch5-sw">
                <Switch on={!!on} onChange={(v) => setTracking(v)} label={t("v2ov.tracker")} />
                <b>{t("v2ov.tracker")}</b>
              </span>
              <span className="ch5-faint">{t("v2ov.offAnyTime")}</span>
            </div>
          )}
          <span className="ch5-line">
            <i className="dot" />
            {t("v2ov.privacyLook")}
          </span>
          <span className="ch5-line">
            <i className="dot" />
            {t("v2ov.privacyTags")}
          </span>
        </div>
        </div>
      </section>

      <section className="ch5-mid">
        <div className="ch5-mid-hd">
          <h1 className="h1" title={ps.some((p) => p && !p.m.hub_only) ? undefined : t("v2ov.noScores")}>
            {t("v2ov.yourWeekend")}
          </h1>
          <Keycap ps="✕" xb="A" kb="Enter" label={t("v2ov.hintOpenMatch")} />
        </div>
        <div className="ch5-strip">
          {at.map((m, i) => {
            const p = ps[i];
            const isLive = i === liveAt;
            return (
              <button
                key={i}
                className={`mt panel ring ${p ? (p.win ? "w" : "l") : isLive ? "live" : "todo"} ${i === focus ? "is-focus" : open && fp && i === focus ? "is-sel" : ""}`}
                data-f
                disabled={!p && !isLive}
                title={p?.dnf ? t("champs.dnf") : undefined}
                onClick={() => {
                  setFocus(i);
                  if (p) setOpen(true);
                }}
              >
                <span className="no num">{String(i + 1).padStart(2, "0")}</span>
                <span className="r">{p ? t(p.win ? "v2ov.w" : "v2ov.l") : isLive ? t("champs.live") : m ? "…" : ""}</span>
                {p?.dnf ? <span className="tag dnf">{t("v2ov.dnf")}</span> : <i className="bar-b" />}
              </button>
            );
          })}
        </div>
        {played === 0 && !pending ? (
          <div className="ch5-wk">
            <Guide on={on} />
            <div className="ch5-col">{clockBox}</div>
          </div>
        ) : (
          <div className="ch5-wk">
            <div className="panel ring ch5-table">
              <div className="ch5-th" aria-hidden="true">
                <span>#</span>
                <span>{t("v2ov.result")}</span>
                <span>{t("v2ov.rankReached")}</span>
                <span className="r">{t("v2ov.winsLosses")}</span>
              </div>
              <div className="list rule ch5-rows">
                {ps.map((p, i) => (
                  <div
                    key={i}
                    className={`lrow ch5-tr ${p ? "" : "todo"} ${i === focus ? "is-focus" : ""}`}
                    data-f={p ? "" : undefined}
                    onClick={() => {
                      if (!p) return;
                      setFocus(i);
                      setOpen(true);
                    }}
                  >
                    <span className="num ch5-faint">{String(i + 1).padStart(2, "0")}</span>
                    <span className={p?.win ? "strong" : "ch5-muted"}>{p ? `${t(p.win ? "champs.short.win" : "champs.short.loss")}${p.dnf ? ` · ${t("v2ov.dnf")}` : ""}` : i === liveAt ? t("champs.live") : ""}</span>
                    <span className="ch5-muted ch5-rr">
                      {p && p.w > 0 ? (
                        <>
                          <Rank i={p.w - 1} got size="s" name={RANKS[p.w - 1]} />
                          <span>{RANKS[p.w - 1]}</span>
                        </>
                      ) : p ? (
                        "–"
                      ) : null}
                    </span>
                    <span className="num r ch5-muted">
                      {p ? (
                        <>
                          <b>{p.w}</b> W · <b>{p.l}</b> L
                        </>
                      ) : null}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div className="ch5-col">
              <div className="panel ring ch5-box">
                <span className="eyebrow">{t("v2ov.winRuns")}</span>
                {runsW.length ? (
                  runsW.slice(0, 4).map(([a, b]) => (
                    <div key={a} className="ch5-row">
                      <span className="ch5-muted">{t("v2ov.matchesRange", { a, b })}</span>
                      <span className="ch5-run">
                        <span className="ticks" style={{ width: (b - a + 1) * 14 }}>
                          {Array.from({ length: b - a + 1 }, (_, k) => (
                            <i key={k} className="w" />
                          ))}
                        </span>
                        <b className="num">{b - a + 1}</b>
                      </span>
                    </div>
                  ))
                ) : (
                  <span className="ch5-muted">{t("v2ov.noRuns")}</span>
                )}
              </div>
              {clockBox}
              <div className="panel ring ch5-box">
                <span className="eyebrow">{t("v2ov.tiersReached")}</span>
                {([[1, 6], [2, 11]] as const).map(([ti, w]) => (
                  <div key={ti} className="ch5-row">
                    <span className="ch5-muted">{t("v2ov.tierAt", { tier: RANK_TIERS[ti], count: w })}</span>
                    <span>{tierAt(w) ? t("v2ov.atMatch", { n: tierAt(w)! }) : <span className="ch5-faint">{t("v2ov.notYet")}</span>}</span>
                  </div>
                ))}
              </div>
              <div className="panel ring ch5-chart">
                <div className="ch5-row">
                  <span className="eyebrow">{t("v2ov.record")}</span>
                  <span className="ch5-legend">
                    <span>
                      <i className="lw" />
                      {t("v2ov.wins")}
                    </span>
                    <span>
                      <i className="ll" />
                      {t("v2ov.loss")}
                    </span>
                  </span>
                </div>
                <RecordChart ps={ps} />
              </div>
            </div>
          </div>
        )}
      </section>

      {open && fp ? <MatchDetail p={fp} onBack={() => setOpen(false)} /> : <Ladder wins={wins} done={complete} />}
    </div>
  );
}
