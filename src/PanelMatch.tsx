// The side panel's Match tab (mockup design/d-draft-2/07-side-panel.html, T24): the match brief at
// the edge of the screen. In the menus it is the brief for the next match of the session the user
// plays (the overlay's pick – shared, panelShare.ts); in a match it adds the match clock and the
// next sub. One column of sections split by hairlines, every row a tag + text + count.
import { useEffect, useMemo, useRef, useState } from "react";
import { api, events, type MatchClock } from "./api";
import { num } from "./format";
import { t } from "./i18n";
import { onSharedPlan, sharedPlan, useSessionPick } from "./panelShare";
import { benchOf, placeLabel, SessionList } from "./Squads";
import { defaultSquadPrefs, type ClubEntry, type MatchBrief, type SessionPlan, type SquadPrefs, type SquadsView } from "./squadsData";
import { Dot, FaceChip } from "./ui";

/** A plan older than this is worked out again when the panel shows it (the overlay's rule). */
const FRESH_MS = 10 * 60_000;
/** A shared plan older than this (an earlier run of the app) isn't shown while the new one is worked out. */
const SHOW_MS = 60 * 60_000;
const recentShared = () => {
  const p = sharedPlan();
  return p && Date.now() - p.at < SHOW_MS ? p : null;
};

/**
 * The plan for the panel: the one any window worked out last (the overlay usually) at once, worked
 * out here only when nothing has it, or when something it depends on changed and no other window
 * shared a newer one within a moment.
 */
export function usePanelPlan(): [SquadsView | null, boolean, (p: SquadPrefs) => void] {
  const [view, setView] = useState<SquadsView | null>(() => recentShared()?.view ?? null);
  const [busy, setBusy] = useState(false);
  const at = useRef(recentShared()?.at ?? 0);
  const dirtyAt = useRef(0);
  const timer = useRef(0);
  useEffect(() => {
    const load = () => {
      setBusy(true);
      api
        .squadsPlan()
        .then((v) => {
          at.current = Date.now();
          setView(v);
        })
        .catch(() => {})
        .finally(() => setBusy(false));
    };
    if (!view || Date.now() - at.current > FRESH_MS) load();
    // another window worked it out: take it
    const off = onSharedPlan((p) => {
      if (p.at <= at.current) return;
      at.current = p.at;
      setView(p.view);
      window.clearTimeout(timer.current);
    });
    // something it depends on changed: the overlay (if open) shares a new one; else work it out here
    const dirty = (wait: number) => () => {
      dirtyAt.current = Date.now();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => at.current < dirtyAt.current && load(), wait);
    };
    const un = [events.onSquadsChanged(dirty(1500)), events.onSyncDone(dirty(6000)), events.onGalleryUpdated(dirty(6000))];
    return () => {
      off();
      window.clearTimeout(timer.current);
      un.forEach((p) => p.then((u) => u()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // a change here (unlock …): saved; the app tells every window to plan again
  const setPrefs = (p: SquadPrefs) => {
    setView((v) => (v ? { ...v, prefs: p } : v));
    api.setSquadPrefs(p).catch(() => {});
  };
  return [view, busy, setPrefs];
}

/** The dev preview's match: `?view=missing&match=68` (the clock at 68'). */
const devMatch = import.meta.env.DEV ? new URLSearchParams(location.search).get("match") : null;

/** The last clock reading in this match (null until the scoreboard was read). */
function useMatchClock(inMatch: boolean): MatchClock | null {
  const [clock, setClock] = useState<MatchClock | null>(devMatch && devMatch !== "1" ? { minute: Number(devMatch), needs: [] } : null);
  useEffect(() => {
    const un = events.onMatchClock(setClock);
    return () => void un.then((u) => u());
  }, []);
  useEffect(() => {
    if (!inMatch && !devMatch) setClock(null);
  }, [inMatch]);
  return clock;
}

/** Match reminders' settings: on/off and the general sub minute. */
function useReminders(): { on: boolean; subAt: number } {
  const [r, setR] = useState({ on: true, subAt: 70 });
  useEffect(() => {
    api
      .uiPrefs()
      .then((p) => setR({ on: p.reminders?.on ?? true, subAt: p.reminders?.sub_at ?? 70 }))
      .catch(() => {});
  }, []);
  return r;
}

/** One step before the match, in the overlay's words (Squads.tsx MatchBriefView). */
function stepText(x: MatchBrief["before"][number], benchNames: string): string {
  switch (x.kind) {
    case "ready":
      return t("brief.ready", { formation: x.text });
    case "squad":
      return x.count != null ? t("brief.squad", { formation: x.text, count: x.count }) : t("brief.squadNew", { formation: x.text });
    case "buy":
      return x.count != null ? t("brief.buy", { card: x.text, price: num(x.count) }) : t("brief.buySearch", { card: x.text });
    case "use":
      return t("brief.use", { what: x.text });
    case "bench":
      return t("brief.benchEach", { names: benchNames || x.text });
    case "rush":
      return t("brief.rush", { card: x.text });
    case "rush_buy":
      return x.count != null ? t("brief.rushBuy", { card: x.text, price: num(x.count) }) : t("brief.rushSearch", { card: x.text });
    case "rules":
      return t("brief.rules", { range: x.text });
    case "cap":
      return t("brief.cap", { rating: x.text, count: x.count ?? 1 });
    case "unread":
      return t("brief.unread", { event: x.text });
  }
}

/** The step's own subject (formation, card, kit, names) in bold, the wording around it regular. */
function Strong({ text, subject }: { text: string; subject: string }) {
  const at = subject ? text.indexOf(subject) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b>{subject}</b>
      {text.slice(at + subject.length)}
    </>
  );
}

const Left = ({ n }: { n: number }) => (
  <span className="ml-left">
    <b className="num">{n}</b> {t("v2panel.left")}
  </span>
);

/** The panel's Match tab. `inMatch`: the clock and the next sub on top, no steps before the match. */
export function PanelMatch({ inMatch = false }: { inMatch?: boolean }) {
  const [view, busy, setPrefs] = usePanelPlan();
  const [picked, pick] = useSessionPick(view);
  const clock = useMatchClock(inMatch);
  const rem = useReminders();
  const prefs = view?.prefs ?? defaultSquadPrefs;
  const club = useMemo(() => new Map<number, ClubEntry>((view?.club ?? []).map((c) => [c.key, c])), [view]);

  if (!view) {
    // a real wait: nothing worked the plan out yet (named, every wait visible)
    return (
      <div className="ml-body">
        <section className="ml-sec">{busy || !view ? <p className="ml-wait">{t("squads.loading")}</p> : null}</section>
      </div>
    );
  }
  if (view.needs_sync) {
    return (
      <div className="ml-body">
        <section className="ml-sec">
          <b>{t("squads.needsSync.title")}</b>
          <p className="ml-muted">{t("squads.needsSync.body")}</p>
        </section>
      </div>
    );
  }
  const list = view.combos;
  const s: SessionPlan | undefined = list.find((x) => x.id === picked) ?? list[0];
  if (!s) {
    return (
      <div className="ml-body">
        <section className="ml-sec">
          <p className="ml-muted">{busy ? <span className="ml-wait">{t("squads.building", { count: view.club_players })}</span> : t("squads.play.none")}</p>
        </section>
      </div>
    );
  }
  const i = Math.max(0, list.indexOf(s));
  const step = (d: number) => pick(list[(i + d + list.length) % list.length].id);
  const minute = (key: number) => prefs.sub_at?.[String(key)] ?? rem.subAt;
  const bench = benchOf(s);
  const benchNames = bench.map((b) => `${b.name} ${minute(b.key)}:00`).join(", ");
  const stNow = s.stages.find((x) => x.from <= s.played + 1 && (x.to == null || s.played + 1 <= x.to)) ?? null;
  const squad = stNow?.squad ?? s.squad;
  const changes = s.stages.filter((x) => x.swaps.length > 0 && x.from > s.played + 1);
  const b = s.brief;
  const evos = s.evos ?? [];

  // the next sub: from the clock reading (the app's own list) or, before one, from the plan
  const planned = [
    ...evos.filter((e) => !e.start || !e.in_xi).map((e) => ({ player: e.player, what: t("squads.evo.level", { name: e.name, level: e.level, levels: e.levels }), at: minute(e.key) })),
    ...(s.bench ?? []).map((x) => ({ player: x.name, what: x.objectives.slice(0, 2).join(", "), at: minute(x.key) })),
  ];
  const fromClock = clock?.needs.length ? clock.needs.map((n) => ({ player: n.player, what: n.bench ? n.evo : t("squads.evo.level", { name: n.evo, level: n.level, levels: n.levels }), at: n.at })) : null;
  const next = (fromClock ?? planned).filter((n) => clock == null || n.at >= clock.minute).sort((a, b) => a.at - b.at)[0] ?? null;

  const clubCard = (key: number, name: string, rating?: number, pos?: string) => {
    const c = club.get(key);
    return { name, rating: rating ?? c?.rating ?? null, position: pos ?? c?.positions[0] ?? null, rareflag: c?.rareflag ?? null, defId: c?.def_id ?? null };
  };

  return (
    <div className="ml-body">
      {/* what is played: the overlay's pick, stepped here too */}
      <section className="ml-sec">
        <div className="ml-row2">
          <span className="eyebrow">{t("brief.title")}</span>
          <span className="ml-faint">{t("squads.play.objectives", { count: s.counted })}</span>
        </div>
        {busy && <p className="ml-wait ml-small">{t("v2panel.updating")}</p>}
        <div className="ml-pick" role="group" aria-label={t("squads.play.sessions")}>
          {list.length > 1 && (
            <button onClick={() => step(-1)} aria-label={t("squads.prevEvent")} title={t("squads.prevEvent")}>
              ‹
            </button>
          )}
          <b className="ml-pick-name" title={s.title}>
            {s.quick != null ? t("squads.play.quickTitle", { count: s.quick }) : placeLabel(s.place, s.place_name)}
          </b>
          {list.length > 1 && (
            <span className="ml-pick-n num" aria-hidden="true">
              {i + 1}/{list.length}
            </span>
          )}
          {list.length > 1 && (
            <button onClick={() => step(1)} aria-label={t("squads.nextEvent")} title={t("squads.nextEvent")}>
              ›
            </button>
          )}
        </div>
        {stNow && (
          <span className="ml-muted ml-small">
            {stNow.to == null ? t("squads.plan.from", { from: stNow.from }) : t("squads.plan.range", { from: stNow.from, to: stNow.to })}
            {stNow.to != null && <> · {t("squads.plan.nextChange", { count: Math.max(0, stNow.to - s.played) })}</>}
          </span>
        )}
        {prefs.locked && (
          <div className="ml-row2 ml-small">
            <span>
              <b>{t("squads.lock.bar", { formation: prefs.locked.formation })}</b> <span className="ml-muted">{prefs.locked.title.split(" · ")[0]}</span>
            </span>
            <button className="ml-link" onClick={() => setPrefs({ ...prefs, locked: null })}>
              {t("squads.lock.unlock")}
            </button>
          </div>
        )}
      </section>

      {inMatch && rem.on && (
        <section className="ml-sec">
          <div className="ml-clock">
            <div className="ml-col">
              <span className="eyebrow">{t("v2panel.clock")}</span>
              {clock ? <span className="num ml-clock-n">{clock.minute}'</span> : <span className="ml-wait">{t("v2panel.clockWait")}</span>}
            </div>
            {clock && (
              <span className="chip ring line">
                <Dot tone="accent" live />
                {t("v2panel.live")}
              </span>
            )}
          </div>
          {next && (
            <div className="ml-next-sub">
              <span className="tag accent">
                <span className="num">{next.at}:00</span>
              </span>
              <div className="ml-col">
                <b>
                  {t("v2panel.subOn", { player: next.player })}
                  {clock && next.at > clock.minute && <> · {t("v2panel.inMin", { count: next.at - clock.minute })}</>}
                </b>
                {next.what && <span className="ml-muted ml-small">{next.what}</span>}
              </div>
            </div>
          )}
        </section>
      )}

      {!inMatch && b && b.before.length > 0 && (
        <section className="ml-sec">
          <span className="eyebrow">{t("brief.before")}</span>
          <ol className="ml-steps">
            {b.before.map((x, k) => (
              <li key={k} className={x.kind === "unread" || x.kind === "rules" || x.kind === "cap" ? "warn" : ""}>
                <span className="ml-step-n num" aria-hidden="true">
                  {k + 1}
                </span>
                <span>
                  <Strong text={stepText(x, benchNames)} subject={x.kind === "bench" ? benchNames || x.text : x.text} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {b && b.players.length > 0 && (
        <section className="ml-sec">
          <span className="eyebrow">{t("v2panel.players")}</span>
          {b.players.map((p) =>
            p.tasks.map((x, k) => (
              <div className="ml-task" key={`${p.name}-${k}`}>
                {k === 0 ? <span className="tag">{p.bench ? t("v2panel.sub") : p.pos}</span> : <span />}
                <span>
                  {k === 0 && (
                    <>
                      <b>{p.name}</b> ·{" "}
                    </>
                  )}
                  {x.text}
                </span>
                <Left n={x.left} />
              </div>
            )),
          )}
        </section>
      )}

      {b && b.anyone.length > 0 && (
        <section className="ml-sec">
          <span className="eyebrow">{t("brief.anyone")}</span>
          {b.anyone.map((x, k) => (
            <div className="ml-task" key={k}>
              <span className="tag">{t("v2panel.any")}</span>
              <span>{x.text}</span>
              <Left n={x.left} />
            </div>
          ))}
        </section>
      )}
      {b && b.players.length === 0 && b.anyone.length === 0 && (
        <section className="ml-sec">
          <p className="ml-muted">{t("brief.nothing")}</p>
        </section>
      )}

      {changes.length > 0 && (
        <section className="ml-sec">
          <span className="eyebrow">{t("v2panel.changes")}</span>
          {changes.map((st) => (
            <div className="ml-task" key={st.from}>
              <span className="tag">{t(st.to === st.from ? "v2panel.matchTag" : "v2panel.matchTagOn", { n: st.from })}</span>
              <span className="ml-col">
                {st.swaps.map((w, k) => (
                  <span key={k}>
                    {w.out_name} → <b>{w.in_name}</b>
                  </span>
                ))}
              </span>
              <span />
            </div>
          ))}
        </section>
      )}

      {squad && (
        <section className="ml-sec">
          <div className="ml-row2">
            <span className="eyebrow">{t("v2panel.xi", { formation: squad.formation })}</span>
            <span className="ml-faint ml-small">
              {t("v2panel.chem")} <b className="num">{squad.chem}</b>
            </span>
          </div>
          <div className="ml-xi">
            {squad.slots.map((sl, k) => (
              <span key={k} className={sl.owned === false ? "to-get" : ""} title={sl.owned === false ? t("v2panel.toGet") : undefined}>
                <span className="tag">{sl.pos}</span>
                <span className="ml-ellip">{sl.name}</span>
                <b className="num">{sl.rating}</b>
              </span>
            ))}
            {bench.map((x) => (
              <span key={`b${x.key}`} className="sub">
                <span className="tag">{t("v2panel.sub")}</span>
                <span className="ml-ellip">{x.name}</span>
                <b className="num">{x.rating || ""}</b>
              </span>
            ))}
          </div>
        </section>
      )}

      {evos.length > 0 && (
        <section className="ml-sec">
          <span className="eyebrow">{t("v2panel.evos")}</span>
          {evos.map((e) => (
            <div className="ml-task ml-evo" key={`${e.key}-${e.name}`}>
              <FaceChip card={clubCard(e.key, e.player, e.rating, e.pos)} s={30} />
              <span>
                <b>{e.player}</b> · {e.name} <span className="num">{e.level}/{e.levels}</span>
                <span className="ml-muted ml-small ml-block">
                  {e.start && e.in_xi ? t("squads.evo.starts") : e.in_xi ? t("squads.evo.inXi") : t("squads.evo.bench", { minute: minute(e.key) })} · {e.progress}/{e.target}
                </span>
              </span>
              {!(e.start && e.in_xi) && !e.in_xi ? (
                <span className="tag accent">
                  <span className="num">{minute(e.key)}:00</span>
                </span>
              ) : (
                <span className="tag">{t("v2panel.xiTag")}</span>
              )}
            </div>
          ))}
        </section>
      )}

      {!inMatch && s.items.length > 0 && (
        <section className="ml-sec">
          <details className="ml-all">
            <summary>{t("brief.all", { count: s.items.length })}</summary>
            <SessionList s={s} compact />
          </details>
        </section>
      )}
    </div>
  );
}
