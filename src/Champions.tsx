// Champions (beta): the weekend as FC-Tracker read it from the game – record, rank progress, every
// match with its score, goal minutes and opponent, and what the weekend says about your game.
// The same component in the app overlay and on FC-Tracker Web (where it explains that matches are
// read by the app).
import { useEffect, useState, type ReactNode } from "react";
import { api, events, IS_WEB } from "./api";
import { emptyChamps, goals, shownScore, sides, weekendStats, type ChampsData, type ChampsMatch, type ChampsRun } from "./championsData";
import { num } from "./format";
import { BOARD_PAGE, boardName, fetchBoard, markChampsTabSeen, setChampsNewsState, type Board } from "./championsBoard";
import { t } from "./i18n";

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
 *  in the overlay switches it on (the "fct:champions-switch" event). */
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
  return [on, switchOn];
}

/** The announcement while the tracker is off: what it does, that it is a beta, one button. */
function News({ onSwitch, keys, full }: { onSwitch?: () => void; keys?: ReactNode; full?: boolean }) {
  return (
    <section className={`ch-news ${full ? "full" : ""}`} aria-label={t("champs.news.title")}>
      <p className="eyebrow">{t("champs.news.eyebrow")}</p>
      <h2>{t("champs.news.title")}</h2>
      <p>{t("champs.news.text")}</p>
      <ul className="ch-news-points">
        <li>{t("champs.news.point1")}</li>
        <li>{t("champs.news.point2")}</li>
        <li>{t("champs.news.point3")}</li>
      </ul>
      {onSwitch ? (
        <>
          <button className="theme-btn ch-news-btn" onClick={onSwitch}>
            {keys} {t("champs.news.switch")}
          </button>
          <p className="ch-news-small">{t("champs.news.how")}</p>
        </>
      ) : (
        <p className="ch-news-small">{t("champs.webOnly")}</p>
      )}
    </section>
  );
}

function timeLeft(endsAt: number | null): string | null {
  if (!endsAt) return null;
  const ms = endsAt - Date.now();
  if (ms <= 0) return null;
  const h = Math.round(ms / 3_600_000);
  return h >= 24 ? t("champs.days", { days: Math.floor(h / 24), hours: h % 24 }) : t("champs.hours", { hours: h });
}

function OutcomeChip({ m }: { m: ChampsMatch }) {
  const o = m.outcome;
  const cls = o === "win" ? "win" : o === "quit" ? "quit" : o === "loss" ? "loss" : "open";
  return <span className={`ch-chip ${cls}`}>{o ? t(`champs.short.${o}`) : "…"}</span>;
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
  const open = () => api.openSite(BOARD_PAGE).catch(() => {});
  return (
    <div className="ch-board">
      <p className="eyebrow">{t("champs.board.title")}</p>
      {name ? (
        <p>
          {board?.me ? <b>{t("champs.board.pos", { pos: board.me.pos, players: num(board.players) })}</b> : t("champs.board.waiting", { name })}
        </p>
      ) : (
        <p>{t("champs.board.join")}</p>
      )}
      <button className="theme-btn" onClick={open}>{t("champs.board.open")}</button>
    </div>
  );
}

export default function Champions({ keys }: { keys?: ReactNode }) {
  const data = useChampions();
  const [on, switchOn] = useChampsOn();
  if (IS_WEB) return <News full />;
  if (!data) return <div className="ov-empty"><p className="ml-loading">{t("champs.loading")}</p></div>;
  const run = data.runs[data.runs.length - 1];
  const hub = run?.hub ?? data.last_hub;
  const pending = data.pending && (data.pending.last || data.pending.score || data.pending.home.abbr) ? data.pending : null;
  const news = on === false ? <News onSwitch={switchOn} keys={keys} full={!hub && !pending} /> : null;
  if (!hub && !pending) {
    if (news) return news;
    return (
      <div className="ov-empty ch-empty">
        <p className="eyebrow">{t("section.champions")} · {t("champs.beta")}</p>
        <h2>{t("champs.emptyTitle")}</h2>
        <p>{t("champs.empty")}</p>
      </div>
    );
  }
  const left = timeLeft(hub?.ends_at ?? null);
  const matches = [...(run?.matches ?? [])].reverse();
  const form = weekendStats(run ?? { id: 0, ends_at: null, hub: hub!, matches: [] }).form;
  const earlier = data.runs.slice(0, -1).reverse();
  return (
    <div className="ch">
      {news}
      <header className="ch-head">
        <div>
          <p className="eyebrow">{t("section.champions")} · {t("champs.beta")}</p>
          <h1 className="detail-title">{hub?.rank ?? t("section.champions")}</h1>
          <p className="detail-sub">
            {[left && t("champs.ends", { time: left }), hub?.points != null && t("champs.points", { points: hub.points })].filter(Boolean).join(" · ")}
          </p>
        </div>
        {hub && (
          <div className="ch-record">
            <b>{hub.wins}<span>–</span>{hub.losses}</b>
            <small>{t("champs.left", { count: hub.remaining })}</small>
          </div>
        )}
      </header>
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
        <div className="ch-side">
          {run && run.matches.length > 0 && <Stats run={run} />}
          <BoardCard />
        </div>
      </div>
      {earlier.length > 0 && (
        <section className="ch-history">
          <p className="eyebrow">{t("champs.history")}</p>
          <ul>
            {earlier.map((r) => {
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
      )}
      <p className="ch-privacy">{t("champs.privacy")}</p>
    </div>
  );
}
