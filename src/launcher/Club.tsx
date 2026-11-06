// The launcher's Club tab (01's "Club 198"): the synced club, strongest by FC-Tracker's meta rating first –
// each card at its best position, with its other positions, rating. Loan cards are left out (not the club's). Search by name and filter
// by line, like the overlay's club search. Real data only (squads.rs ClubEntry); a card the engine hasn't
// rated says so.
import { useEffect, useMemo, useState } from "react";
import { api, events, formatAge } from "../api";
import { getLocale, t } from "../i18n";
import type { ClubEntry } from "../squadsData";
import { FaceChip, Panel, fmt } from "../ui";
import { clubCard } from "./cards";
import { matches } from "../search";

const LINES = { all: [], gk: ["GK"], def: ["CB", "LB", "RB", "LWB", "RWB"], mid: ["CDM", "CM", "CAM", "LM", "RM"], att: ["ST", "CF", "LW", "RW"] } as const;
type Line = keyof typeof LINES;
const LINE_LABEL: Record<Line, string> = { all: "", gk: "GK", def: "DEF", mid: "MID", att: "ATT" };

const best = (c: ClubEntry): [string, number] | null => {
  const e = Object.entries(c.meta ?? {});
  return e.length ? e.sort((a, b) => b[1] - a[1])[0] : null;
};
const meta1 = (n: number) => n.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export default function Club() {
  const [club, setClub] = useState<ClubEntry[] | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [line, setLine] = useState<Line>("all");
  useEffect(() => {
    const load = () =>
      api
        .squadsPlan()
        .then((v) => {
          // loan cards are not the club's (user 2026-11-05): never listed or counted
          setClub(v.club.filter((c) => c.owned && !c.loan));
          setReadAt(v.read_at);
        })
        .catch(() => setClub([]));
    load();
    const un = events.onSyncDone(load);
    return () => void un.then((u) => u());
  }, []);

  const rows = useMemo(() => {
    const w = q.trim();
    const want = LINES[line] as readonly string[];
    return (club ?? [])
      .filter((c) => !w || matches(c.name, w))
      .filter((c) => !want.length || c.positions.some((p) => want.includes(p)))
      .map((c) => ({ c, b: best(c) }))
      .sort((x, y) => (y.b?.[1] ?? -1) - (x.b?.[1] ?? -1) || y.c.rating - x.c.rating || x.c.name.localeCompare(y.c.name));
  }, [club, q, line]);

  return (
    <section className="ln-page ln-club">
      <div className="row between ln-page-head">
        <h1 className="h1">{t("lh.nav.club")}</h1>
        <div className="row ln-club-tools">
          <input className="ln-input wide" type="search" value={q} placeholder={t("lh.club.search")} aria-label={t("lh.club.search")} onChange={(e) => setQ(e.target.value)} />
          <span className="ln-choice" role="group" aria-label={t("lh.club.best")}>
            {(Object.keys(LINES) as Line[]).map((l) => (
              <button key={l} type="button" className={`seg ring ${line === l ? "is-on" : ""}`} aria-pressed={line === l} onClick={() => setLine(l)}>
                <span>{l === "all" ? t("lh.club.all") : LINE_LABEL[l]}</span>
              </button>
            ))}
          </span>
        </div>
      </div>
      <Panel className="ln-panel ln-club-panel">
        {club == null ? (
          <p className="lh-wait">{t("lh.club.loading")}</p>
        ) : club.length === 0 ? (
          <p className="t-14 muted">{t("lh.club.none")}</p>
        ) : (
          <>
            <div className="row between ln-club-head t-13 faint">
              <span>
                {t("lh.club.count", { count: rows.length })}
                {readAt ? ` · ${t("lh.club.synced", { age: formatAge(readAt) })}` : ""}
              </span>
              <span className="row ln-club-cols">
                <span>{t("lh.club.rating")}</span>
                <span>{t("lh.club.meta")}</span>
              </span>
            </div>
            {rows.length === 0 ? (
              <p className="t-14 muted">{t("lh.club.noMatch")}</p>
            ) : (
              <div className="list rule ln-club-list">
                {rows.map(({ c, b }) => (
                  <div key={c.key} className="lrow ln-club-row">
                    <FaceChip card={clubCard(c, b?.[0])} s={40} pos={b?.[0] ?? c.positions[0]} />
                    <span className="col ln-club-who">
                      <b className="strong ellip">{c.name}</b>
                      <span className="row t-13 muted ln-club-pos">
                        {c.positions.map((p) => (
                          <span key={p} className={p === b?.[0] ? "strong" : ""}>
                            {p}
                          </span>
                        ))}
                      </span>
                    </span>
                    <span className="num t-16 ln-club-r">{fmt(c.rating)}</span>
                    <span className="num t-16 ln-club-m">{b ? `${b[0]} ${meta1(b[1])}` : <span className="t-13 faint">{t("lh.club.notRated")}</span>}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Panel>
    </section>
  );
}
