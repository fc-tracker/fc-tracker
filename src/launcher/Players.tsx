// The launcher's Players tab (user 2026-11-05: "a Players tab with every collected card, so I can handle them there –
// finding the card inside its set is frustrating; and the reader may read a wrong card, like an 85 Risser I couldn't
// delete"): every card the Gallery counts, searchable (forgiving search), with what FC-Tracker knows about its first
// owner and from where, and the user's word on it – first owner yes / no / automatic, and "wrong read" to take a card
// out (it stays out until put back, whatever a later read says). Real data only (lib.rs gallery_cards).
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, events, type CardRow } from "../api";
import { t } from "../i18n";
import { matches } from "../search";
import { FutCard, Gem, Panel, fmt, type FutCardData } from "../ui";

type Filter = "all" | "fo" | "notfo" | "unknown" | "removed";
type Sort = "rating" | "score" | "name";
type Key = Parameters<typeof t>[0];

const isFo = (r: CardRow) => r.first_owner === "known" || r.first_owner === "scanned" || r.first_owner === "manual";
const isNot = (r: CardRow) => r.first_owner === "manual_no" || r.first_owner === "scanned_no" || r.first_owner === "club_no";
/** Where the first-owner answer comes from, in the player's words. */
const SOURCE: Record<CardRow["first_owner"], Key> = {
  known: "players.src.known",
  scanned: "players.src.scanned",
  manual: "players.src.manual",
  manual_no: "players.src.manualNo",
  scanned_no: "players.src.scannedNo",
  club_no: "players.src.clubNo",
  unknown: "players.src.unknown",
  none: "players.src.unknown",
};

const card = (r: CardRow): FutCardData => ({
  name: r.name,
  rating: r.rating,
  position: r.position,
  positions: r.positions,
  rareflag: r.rareflag,
  defId: r.def_id,
  holo: r.holo,
  nation: r.nation,
  league: r.league,
  club: r.club,
  face: r.face?.length === 6 ? r.face : null,
  actionGuid: r.art ?? null,
  firstOwner: isFo(r),
});

export default function Players() {
  const [rows, setRows] = useState<CardRow[] | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("rating");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => api.galleryCards().then(setRows).catch(() => setRows([])), []);
  useEffect(() => {
    void load();
    const un = [events.onGalleryUpdated(() => void load()), events.onSyncDone(() => void load())];
    return () => un.forEach((u) => void u.then((f) => f()));
  }, [load]);

  const list = useMemo(() => {
    const keep = (r: CardRow) =>
      filter === "all" ? !r.removed : filter === "removed" ? r.removed : !r.removed && (filter === "fo" ? isFo(r) : filter === "notfo" ? isNot(r) : !isFo(r) && !isNot(r));
    return (rows ?? [])
      .filter((r) => keep(r) && (!q.trim() || matches(r.name ?? "", q)))
      .sort((a, b) => (sort === "name" ? (a.name ?? "").localeCompare(b.name ?? "") : sort === "score" ? b.score - a.score : (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score));
  }, [rows, q, filter, sort]);

  const act = async (r: CardRow, f: () => Promise<unknown>) => {
    setBusy(r.def_id);
    try {
      await f();
      await load();
    } finally {
      setBusy(null);
    }
  };
  const counts = useMemo(() => {
    const all = rows ?? [];
    return { all: all.filter((r) => !r.removed).length, removed: all.filter((r) => r.removed).length };
  }, [rows]);

  return (
    <section className="ln-page ln-players">
      <div className="row between ln-page-head">
        <div className="col" style={{ gap: 4 }}>
          <h1 className="h1">{t("players.title")}</h1>
          <span className="t-14 muted">{rows ? t("players.count", { count: counts.all }) : t("players.loading")}</span>
        </div>
        <div className="row ln-club-tools">
          <input className="ln-input wide" type="search" value={q} placeholder={t("players.search")} aria-label={t("players.search")} onChange={(e) => setQ(e.target.value)} />
          <span className="ln-choice" role="group" aria-label={t("players.filter")}>
            {(["all", "fo", "notfo", "unknown", "removed"] as const).map((f) => (
              <button key={f} type="button" className={`seg ring ${filter === f ? "is-on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                <span>
                  {t(`players.f.${f}` as Key)}
                  {f === "removed" && counts.removed > 0 ? ` · ${counts.removed}` : ""}
                </span>
              </button>
            ))}
          </span>
          <span className="ln-choice" role="group" aria-label={t("players.sort")}>
            {(["rating", "score", "name"] as const).map((s) => (
              <button key={s} type="button" className={`seg ring ${sort === s ? "is-on" : ""}`} aria-pressed={sort === s} onClick={() => setSort(s)}>
                <span>{t(`players.s.${s}` as Key)}</span>
              </button>
            ))}
          </span>
        </div>
      </div>
      <Panel className="ln-panel ln-players-panel">
        {rows == null ? (
          <p className="lh-wait">{t("players.loading")}</p>
        ) : list.length === 0 ? (
          <p className="t-14 muted">{t(rows.length ? "players.none" : "players.empty")}</p>
        ) : (
          <div className="list rule lp-list">
            {list.slice(0, 300).map((r) => (
              <div key={r.def_id} className={`lrow lp-row ${r.removed ? "removed" : ""}`} aria-busy={busy === r.def_id}>
                <FutCard card={card(r)} size="small" w={72} />
                <span className="col lp-main">
                  <b className="strong ellip">{r.name ?? `#${r.def_id}`}</b>
                  <span className="t-13 muted">
                    {r.rating} · {r.position} · <Gem /> {fmt(r.score)}
                  </span>
                  {r.sets.length > 0 && <span className="t-12 faint ellip">{t("players.inSets", { sets: r.sets.join(" · ") })}</span>}
                </span>
                <span className="col lp-fo">
                  <span className={`lp-fo-state ${isFo(r) ? "yes" : isNot(r) ? "no" : ""}`}>{isFo(r) ? t("players.fo.yes") : isNot(r) ? t("players.fo.no") : t("players.fo.unknown")}</span>
                  <span className="t-12 faint">{t(SOURCE[r.first_owner])}</span>
                </span>
                <span className="row lp-acts">
                  {r.removed ? (
                    <button type="button" className="btn btn-secondary ring btn-s" disabled={busy != null} onClick={() => void act(r, () => api.setCardRemoved(r.def_id, false))}>
                      {t("players.putBack")}
                    </button>
                  ) : (
                    <>
                      <span className="ln-choice" role="group" aria-label={t("ui.firstOwner")}>
                        <button type="button" className={`seg ring ${r.first_owner === "manual" ? "is-on" : ""}`} aria-pressed={r.first_owner === "manual"} disabled={busy != null} onClick={() => void act(r, () => api.setFirstOwner(r.def_id, true))}>
                          <span>{t("players.mark.yes")}</span>
                        </button>
                        <button type="button" className={`seg ring ${r.first_owner === "manual_no" ? "is-on" : ""}`} aria-pressed={r.first_owner === "manual_no"} disabled={busy != null} onClick={() => void act(r, () => api.setFirstOwner(r.def_id, false))}>
                          <span>{t("players.mark.no")}</span>
                        </button>
                        <button type="button" className={`seg ring ${r.first_owner !== "manual" && r.first_owner !== "manual_no" ? "is-on" : ""}`} aria-pressed={r.first_owner !== "manual" && r.first_owner !== "manual_no"} disabled={busy != null} onClick={() => void act(r, () => api.setFirstOwner(r.def_id, null))} title={t("players.mark.autoHint")}>
                          <span>{t("players.mark.auto")}</span>
                        </button>
                      </span>
                      <button type="button" className="btn btn-quiet btn-s" disabled={busy != null} onClick={() => void act(r, () => api.setCardRemoved(r.def_id, true))} title={t("players.removeHint")}>
                        {t("players.remove")}
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
            {list.length > 300 && <p className="t-13 muted lp-more">{t("players.more", { count: list.length - 300 })}</p>}
          </div>
        )}
      </Panel>
    </section>
  );
}
