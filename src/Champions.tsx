// Champions (beta): the weekend as FC-Tracker read it from the game – record, rank progress, every
// match with its score, goal minutes and opponent, and what the weekend says about your game.
// Never an empty page: the clock to the end (or the next Weekend League), how it works, and until
// the user's own weekend is read a real example weekend with the same components. The same view in
// the app overlay and on FC-Tracker Web (where matches are read by the app – the strip says so).
import { useEffect, useState, type ReactNode } from "react";
import { api, events, IS_WEB } from "./api";
import { champsClock, emptyChamps, goals, shownScore, sides, weekendStats, type Clock, type ChampsData, type ChampsHub, type ChampsMatch, type ChampsRun } from "./championsData";
import { exampleChamps } from "./championsExample";
import { num } from "./format";
import { BOARD_PAGE, boardName, fetchBoard, markChampsTabSeen, setChampsNewsState, type Board } from "./championsBoard";
import { t, type MessageKey } from "./i18n";

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

function ClockBox({ clock, now }: { clock: Clock; now: number }) {
  const label: MessageKey = clock.live ? (clock.exact ? "champs.clock.ends" : "champs.clock.endsAbout") : "champs.clock.opens";
  return (
    <div className={`ch-clock ${clock.live ? "live" : ""}`} role="timer">
      <small>
        {clock.live && <span className="ch-live-dot" aria-hidden="true" />}
        {t(label)}
      </small>
      <b>{span((clock.live ? clock.ends : clock.opens) - now)}</b>
      <span>{t(clock.exact ? "champs.clock.fromGame" : "champs.clock.usual")}</span>
    </div>
  );
}

function OutcomeChip({ m }: { m: ChampsMatch }) {
  const o = m.outcome;
  const cls = o === "win" ? "win" : o === "quit" ? "quit" : o === "loss" ? "loss" : "open";
  return <span className={`ch-chip ${cls}`}>{o ? t(`champs.short.${o}`) : "…"}</span>;
}

/** Goal minutes on a 90' (or 120') line: above = scored, below = conceded. */
function Timeline({ m }: { m: ChampsMatch }) {
  const gs = goals(m);
  if (!gs.length) return <span className="ch-line empty" />;
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

function MatchRow({ m, live }: { m: ChampsMatch; live?: boolean }) {
  const { opp, me } = sides(m);
  const s = shownScore(m);
  return (
    <li className={`ch-match ${live ? "live" : ""}`}>
      <span className="ch-n">{m.n ?? (live ? "•" : "–")}</span>
      {live ? <span className="ch-chip open">{t("champs.live")}</span> : <OutcomeChip m={m} />}
      <span className="ch-score">
        {s.score ? `${s.score[0]}–${s.score[1]}` : "–"}
        {m.extra_time && <small> {t("champs.aet")}</small>}
      </span>
      <span className="ch-opp">
        <b>{opp.club ?? opp.abbr ?? (m.hub_only ? t("champs.notSeen") : t("champs.unknownOpp"))}</b>
        <small>
          {[opp.gamertag, opp.record ? t("champs.oppRecord", { wins: opp.record[0], losses: opp.record[1] }) : null, me.abbr && opp.abbr ? `${me.abbr} – ${opp.abbr}` : null]
            .filter(Boolean)
            .join(" · ")}
        </small>
        {s.whenLeft && <small className="ch-note">{t("champs.whenLeft", { score: `${s.whenLeft[0]}–${s.whenLeft[1]}`, minute: s.minute ?? 0 })}</small>}
        {m.disconnect && <small className="ch-note">{t("champs.disconnect")}</small>}
        {!m.confirmed && !live && !m.hub_only && <small className="ch-note">{t("champs.unconfirmed")}</small>}
      </span>
      <Timeline m={m} />
      <span className="ch-coins">{m.coins ? t("champs.coins", { coins: num(m.coins) }) : ""}</span>
    </li>
  );
}

function Stats({ run }: { run: ChampsRun }) {
  const s = weekendStats(run);
  const max = Math.max(1, ...s.blocks.map((b) => Math.max(b.for, b.against)));
  const labels = ["0'", "15'", "30'", "45'", "60'", "75'", "ET"];
  return (
    <aside className="ch-stats">
      <p className="eyebrow">{t("champs.weekend")}</p>
      <div className="ch-kpis">
        <div><b>{s.goalsFor}–{s.goalsAgainst}</b><span>{t("champs.goals")}</span></div>
        <div><b>{s.comebacks}</b><span>{t("champs.comebacks")}</span></div>
        <div><b>{s.lateConceded}</b><span>{t("champs.late")}</span></div>
        <div><b>{s.extraTime}</b><span>{t("champs.extraTime")}</span></div>
        <div><b>{s.quits}</b><span>{t("champs.quits")}</span></div>
        <div><b>{s.oppStrength == null ? "–" : `${Math.round(s.oppStrength * 100)} %`}</b><span>{t("champs.oppStrength")}</span></div>
      </div>
      {/* goals by time only once goal minutes were read (a score alone has none) */}
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
    <div className="ch-board">
      <p className="eyebrow">{t("champs.board.title")}</p>
      {name ? (
        <p>{board?.me ? <b>{t("champs.board.pos", { pos: board.me.pos, players: num(board.players) })}</b> : t("champs.board.waiting", { name })}</p>
      ) : (
        <p>{t(IS_WEB ? "champs.board.joinWeb" : "champs.board.join")}</p>
      )}
      {board && board.players > 0 && !board.me && <p className="ch-board-n">{t("champs.board.players", { players: num(board.players) })}</p>}
      <button className="theme-btn" onClick={open}>{t("champs.board.open")}</button>
    </div>
  );
}

/** Record, rank progress, form, the matches and the weekend's numbers – the user's own or the example. */
function Weekend({ run, hub, pending, earlier }: { run: ChampsRun | undefined; hub: ChampsHub | null; pending: ChampsMatch | null; earlier: ChampsRun[] }) {
  const matches = [...(run?.matches ?? [])].reverse();
  const form = run ? weekendStats(run).form : [];
  return (
    <>
      {hub?.rank_pts && (
        <div className="ch-progress" aria-label={t("champs.rankPts", { have: hub.rank_pts[0], need: hub.rank_pts[1] })}>
          <span style={{ width: `${Math.min(100, (hub.rank_pts[0] / Math.max(1, hub.rank_pts[1])) * 100)}%` }} />
          <small>{t("champs.rankPts", { have: hub.rank_pts[0], need: hub.rank_pts[1] })}</small>
        </div>
      )}
      {form.length > 0 && (
        <div className="ch-form" aria-label={t("champs.form")}>
          {form.map((o, i) => (
            <span key={i} className={`ch-dot ${o}`} title={t(`champs.short.${o}`)} />
          ))}
        </div>
      )}
      <div className="ch-grid">
        <section>
          <p className="eyebrow">{t("champs.matches")}</p>
          <ul className="ch-list">
            {pending && <MatchRow m={pending} live />}
            {matches.map((m, i) => (
              <MatchRow key={`${m.started}-${i}`} m={m} />
            ))}
            {!matches.length && !pending && <li className="ch-none">{t("champs.noneYet")}</li>}
          </ul>
        </section>
        <div className="ch-side">{run && run.matches.length > 0 && <Stats run={run} />}</div>
      </div>
      <History runs={earlier} />
    </>
  );
}

/** Earlier weekends: record, rank, date and goals. */
function History({ runs }: { runs: ChampsRun[] }) {
  if (!runs.length) return null;
  return (
    <section className="ch-history">
      <p className="eyebrow">{t("champs.history")}</p>
      <ul>
        {runs.map((r) => {
          const s = weekendStats(r);
          return (
            <li key={r.id}>
              <b>{r.hub.wins}–{r.hub.losses}</b>
              <span>{r.hub.rank ?? ""}</span>
              <small>{new Date(r.id).toLocaleDateString()} · {t("champs.goalsShort", { for: s.goalsFor, against: s.goalsAgainst })}</small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** How it works – four steps, none of them a button to press in the game. */
function Guide({ on }: { on: boolean | null }) {
  return (
    <section className="ch-guide">
      <p className="eyebrow">{t("champs.how.title")}</p>
      <ol className="pl-how ch-how">
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
  const run = own.runs[own.runs.length - 1];
  const hub = run?.hub ?? own.last_hub;
  const pending = own.pending && (own.pending.last || own.pending.score || own.pending.home.abbr) ? own.pending : null;
  const clock = champsClock(own, now);
  // this weekend's hub was read: the user's own weekend; otherwise the example (clearly labelled)
  const mine = !!(hub && hub.ends_at && hub.ends_at > now) || !!pending;
  const ex = exampleChamps(now);
  const exRun = ex.runs[0];
  const status = IS_WEB
    ? t("champs.status.web")
    : on === false
      ? t("champs.status.off")
      : mine
        ? [hub?.points != null && t("champs.points", { points: hub.points }), hub && t("champs.left", { count: hub.remaining })].filter(Boolean).join(" · ")
        : t("champs.status.on");
  return (
    <div className="ch">
      <header className="ch-head">
        <div className="ch-title">
          <p className="eyebrow">
            {t("section.champions")} · {t("champs.beta")}
          </p>
          <h1 className="detail-title">{mine && hub?.rank ? hub.rank : t("champs.title")}</h1>
          <p className="detail-sub">{status}</p>
        </div>
        <ClockBox clock={clock} now={now} />
        {mine && hub && (
          <div className="ch-record">
            <b>
              {hub.wins}
              <span>–</span>
              {hub.losses}
            </b>
            <small>{t("champs.left", { count: hub.remaining })}</small>
          </div>
        )}
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

      {mine ? (
        <Weekend run={run} hub={hub} pending={pending} earlier={own.runs.slice(0, -1).reverse()} />
      ) : (
        <>
          <Guide on={on} />
          <section className="ch-example" aria-label={t("champs.example.title")}>
            <header className="ch-example-head">
              <span className="ch-example-tag">{t("champs.example.tag")}</span>
              <p>{t("champs.example.sub")}</p>
            </header>
            <div className="ch-example-top" inert>
              <div>
                <b className="ch-example-rank">{exRun.hub.rank}</b>
                <small>{t("champs.points", { points: exRun.hub.points ?? 0 })}</small>
              </div>
              <div className="ch-record">
                <b>
                  {exRun.hub.wins}
                  <span>–</span>
                  {exRun.hub.losses}
                </b>
                <small>{t("champs.left", { count: exRun.hub.remaining })}</small>
              </div>
            </div>
            <div className="ch-example-body" inert>
              <Weekend run={exRun} hub={exRun.hub} pending={null} earlier={[]} />
            </div>
          </section>
          <History runs={[...own.runs].reverse()} />
        </>
      )}

      <div className="ch-foot">
        <BoardCard />
        <p className="ch-privacy">{t("champs.privacy")}</p>
      </div>
    </div>
  );
}
