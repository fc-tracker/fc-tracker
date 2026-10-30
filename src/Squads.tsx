// Objective squads (beta, SQUADS.md): every open event with squad objectives, read from the Web
// App by the sync – the checklist, the best XI from the user's own club that ticks as many of
// them as possible at the chemistry they aim for, and realistic cards for what the club can't
// cover. One event at a time (tabs, the mouse first), the checklist next to the pitch; a card
// opens its details. The same view in the app overlay and on FC-Tracker Web; the side panel
// shows the quick version (SquadQuick) and follows the event hub the app sees in the game.
import { useEffect, useState } from "react";
import { api, events, formatAge, IS_WEB } from "./api";
import { num } from "./format";
import { Flag } from "./flags";
import { t, type MessageKey } from "./i18n";
import { defaultSquadPrefs, pitchRows, type ClubEntry, type EventPlan, type GetOption, type ReqView, type SlotView, type SquadPrefs, type SquadsView } from "./squadsData";
import { removeSquad, saveSquad, useSavedSquads } from "./savedSquads";

/** The XI as built now, kept to build later (in the game, from the dashboard, on another device). */
function SaveButton({ e }: { e: EventPlan }) {
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [e.id, e.squad?.formation, e.squad?.strength]);
  if (!e.squad) return null;
  return (
    <button className="cat-tab" disabled={saved} onClick={() => setSaved(!!saveSquad(e))}>
      {saved ? t("squads.savedOk") : t("squads.save")}
    </button>
  );
}

/** Saved objective squads (kept on the account too): what to build, what's still to buy. */
export function SavedSquads({ limit }: { limit?: number }) {
  const list = useSavedSquads();
  const shown = limit ? list.slice(0, limit) : list;
  return (
    <section className="sq-saved" aria-label={t("squads.savedTitle")}>
      <h3>{t("squads.savedTitle")}</h3>
      {shown.length === 0 ? (
        <p className="sq-muted">{t("squads.savedEmpty")}</p>
      ) : (
        <ul>
          {shown.map((s) => {
            const toBuy = s.slots.filter((x) => !x.owned);
            const cost = toBuy.reduce((sum, x) => sum + (x.price ?? 0), 0);
            return (
              <li key={s.id}>
                <div className="sq-saved-head">
                  <b>{s.event}</b>
                  <small className="sq-muted">
                    {t("squads.savedMeta", { formation: s.formation, met: s.met, reqs: s.reqs, when: formatAge(s.saved_at) })}
                  </small>
                  <button className="sq-saved-x" onClick={() => removeSquad(s.id)} aria-label={t("squads.savedRemove")} title={t("squads.savedRemove")}>
                    ×
                  </button>
                </div>
                <p className="sq-saved-xi">
                  {s.slots.map((x, i) => (
                    <span key={i} className={x.owned ? "" : "buy"}>
                      <small>{x.pos}</small> {x.name} <b>{x.rating}</b>
                    </span>
                  ))}
                </p>
                {toBuy.length > 0 && <small className="sq-muted">{t("squads.savedToBuy", { count: toBuy.length, coins: num(cost) })}</small>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const EVENT_PREF = "fct.squads.event";
const readEvent = () => {
  try {
    return Number(localStorage.getItem(EVENT_PREF)) || null;
  } catch {
    return null;
  }
};
const writeEvent = (id: number) => {
  try {
    localStorage.setItem(EVENT_PREF, String(id));
  } catch {}
};

/** The plan, rebuilt after every sync and every settings change. */
export function useSquads(): [SquadsView | null, boolean, (p: SquadPrefs) => void] {
  const [view, setView] = useState<SquadsView | null>(null);
  const [busy, setBusy] = useState(true);
  const load = () => {
    setBusy(true);
    api
      .squadsPlan()
      .then((v) => setView(v))
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    load();
    // a sync brings new objectives and club cards
    const un = events.onGalleryUpdated(() => load());
    return () => {
      un.then((u) => u());
    };
  }, []);
  const setPrefs = (p: SquadPrefs) => {
    setView((v) => (v ? { ...v, prefs: p } : v));
    api.setSquadPrefs(p).then(load).catch(() => {});
  };
  return [view, busy, setPrefs];
}

/** The event shown: the one the game showed last (its hub), else the last picked, else the soonest. */
export function useEventChoice(view: SquadsView | null): [EventPlan | null, (id: number) => void] {
  const [picked, setPicked] = useState<number | null>(readEvent);
  useEffect(() => {
    const un = events.onSquadsFocus((id) => {
      setPicked(id);
      writeEvent(id);
    });
    return () => {
      un.then((u) => u());
    };
  }, []);
  const pick = (id: number) => {
    setPicked(id);
    writeEvent(id);
  };
  const list = view?.events ?? [];
  return [list.find((e) => e.id === picked) ?? list[0] ?? null, pick];
}

function endsIn(ends: number | null): string | null {
  if (!ends) return null;
  const m = Math.max(0, Math.round((ends * 1000 - Date.now()) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? t("champs.time.dh", { d, h: String(h).padStart(2, "0") }) : h > 0 ? t("champs.time.hm", { h, m: String(m % 60).padStart(2, "0") }) : t("champs.time.m", { m: m % 60 });
}

export function reqLabel(r: Pick<ReqView, "need" | "name" | "count">): string {
  switch (r.need.kind) {
    case "icon":
      return t("squads.need.icon", { count: r.count });
    case "hero":
      return t("squads.need.hero", { count: r.count });
    case "rating":
      return t("squads.need.rating", { count: r.count, name: r.name });
    default:
      return t("squads.need.named", { count: r.count, name: r.name });
  }
}

const OPTION_LABEL: Record<GetOption["kind"], MessageKey> = {
  owned: "squads.opt.owned",
  reward: "squads.opt.reward",
  sbc: "squads.opt.sbc",
  cheapest: "squads.opt.cheapest",
  value: "squads.opt.value",
  upgrade: "squads.opt.upgrade",
};

const ACCEL: Record<string, MessageKey> = { explosive: "squads.accel.explosive", controlled: "squads.accel.controlled", lengthy: "squads.accel.lengthy" };

/** The card's bio: preferred foot, weak foot and skill moves – "L · 4★ WF · 5★ SM". */
function Bio({ s, long = false }: { s: Pick<SlotView, "foot" | "weak_foot" | "skill_moves">; long?: boolean }) {
  const foot = s.foot === 2 ? "left" : s.foot === 1 ? "right" : null;
  return (
    <span className={`sq-bio ${long ? "long" : ""}`}>
      {foot && <b className={`sq-foot ${foot}`}>{t(long ? (foot === "left" ? "squads.bio.leftLong" : "squads.bio.rightLong") : foot === "left" ? "squads.bio.left" : "squads.bio.right")}</b>}
      <span>{t(long ? "squads.bio.wfLong" : "squads.bio.wf", { n: s.weak_foot })}</span>
      <span>{t(long ? "squads.bio.smLong" : "squads.bio.sm", { n: s.skill_moves })}</span>
    </span>
  );
}

/** "Has to include": players the user wants in every squad, picked from the club list. */
function MustPick({ view, prefs, onChange }: { view: SquadsView; prefs: SquadPrefs; onChange: (p: SquadPrefs) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const must = prefs.must ?? [];
  const cards = prefs.must_cards ?? [];
  const [found, setFound] = useState<ClubEntry[] | null>(null);
  const byKey = new Map(view.club.map((c) => [c.key, c]));
  for (const c of found ?? []) if (!byKey.has(c.key)) byKey.set(c.key, c);
  const picked = (c: ClubEntry) => (c.owned ? must : cards).includes(c.key);
  const toggle = (c: ClubEntry) => {
    const list = c.owned ? must : cards;
    const next = picked(c) ? list.filter((k) => k !== c.key) : [...list, c.key];
    onChange(c.owned ? { ...prefs, must: next } : { ...prefs, must_cards: next });
  };
  // every card that exists, for players the club doesn't have (3+ letters, after a short pause)
  useEffect(() => {
    setFound(null);
    if (q.trim().length < 3) return;
    const id = window.setTimeout(() => api.squadsSearch(q).then(setFound).catch(() => setFound([])), 250);
    return () => window.clearTimeout(id);
  }, [q]);
  const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = fold(q).split(/\s+/).filter(Boolean);
  const list = view.club.filter((c) => c.owned && words.every((w) => fold(c.name).includes(w) || c.positions.some((p) => p.toLowerCase() === w) || String(c.rating) === w)).slice(0, 80);
  const row = (c: ClubEntry) => (
    <li key={`${c.owned}-${c.key}`}>
      <button className={picked(c) ? "on" : ""} aria-pressed={picked(c)} onClick={() => toggle(c)}>
        <b className="sq-club-rating">{c.rating}</b>
        <Flag nation={c.nation} name={c.nation_name} size={16} />
        <span className="sq-club-name">{c.name}</span>
        <small>{c.positions.join(" · ")}</small>
        {c.loan ? <small className="sq-loan-tag">{t("squads.loan")}</small> : !c.owned ? <small className="sq-price-tag">{c.price != null ? num(c.price) : t("squads.toGet")}</small> : <small />}
        <span className="sq-club-mark" aria-hidden="true">{picked(c) ? "✓" : "+"}</span>
      </button>
    </li>
  );
  return (
    <div className="sq-must">
      <div className="sq-must-row">
        <span className="sq-must-title">{t("squads.must.title")}</span>
        {must.length + cards.length === 0 && <small className="sq-muted">{t("squads.must.none")}</small>}
        {[...must, ...cards].map((k) => {
          const c = byKey.get(k);
          return (
            <button key={k} className={`sq-chip ${c && !c.owned ? "to-get" : ""}`} onClick={() => c && toggle(c)} title={t("squads.must.remove", { name: c?.name ?? "" })}>
              {c && <Flag nation={c.nation} name={c.nation_name} size={14} />}
              <b>{c?.rating ?? ""}</b> {c?.name ?? `#${k}`}
              {c && !c.owned && <small>{t("squads.toGet")}</small>}
              <span aria-hidden="true">✕</span>
            </button>
          );
        })}
        <button className={`cat-tab ${open ? "active" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t("squads.must.done") : t("squads.must.add")}
        </button>
      </div>
      {open && (
        <div className="sq-club">
          <input className="sq-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("squads.must.search")} aria-label={t("squads.must.search")} autoFocus />
          <ul className="sq-club-list">
            {list.map(row)}
            {list.length === 0 && <li className="sq-muted">{t("squads.must.noMatch")}</li>}
          </ul>
          {q.trim().length >= 3 && (
            <>
              <small className="sq-club-head">{t("squads.must.catalog")}</small>
              {found == null ? (
                <p className="ml-loading sq-muted">{t("squads.must.searching")}</p>
              ) : (
                <ul className="sq-club-list">
                  {found.map(row)}
                  {found.length === 0 && <li className="sq-muted">{t("squads.must.noCards")}</li>}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Settings({ prefs, onChange }: { prefs: SquadPrefs; onChange: (p: SquadPrefs) => void }) {
  const [chem, setChem] = useState(prefs.chem_target);
  useEffect(() => setChem(prefs.chem_target), [prefs.chem_target]);
  const commit = () => chem !== prefs.chem_target && onChange({ ...prefs, chem_target: chem });
  return (
    <div className="sq-settings" role="group" aria-label={t("squads.settings")}>
      <label className="sq-chem">
        <span>{t("squads.chemTarget", { value: chem })}</span>
        <input type="range" min={0} max={33} value={chem} onChange={(e) => setChem(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
      </label>
      <div className="sq-order" role="radiogroup" aria-label={t("squads.order")}>
        <button className={`cat-tab ${!prefs.chem_first ? "active" : ""}`} aria-pressed={!prefs.chem_first} onClick={() => onChange({ ...prefs, chem_first: false })}>
          {t("squads.orderReqs")}
        </button>
        <button className={`cat-tab ${prefs.chem_first ? "active" : ""}`} aria-pressed={prefs.chem_first} onClick={() => onChange({ ...prefs, chem_first: true })}>
          {t("squads.orderChem")}
        </button>
      </div>
      <label className="sq-check">
        <input type="checkbox" checked={prefs.hide_loans} onChange={(e) => onChange({ ...prefs, hide_loans: e.target.checked })} />
        <span>{t("squads.hideLoans")}</span>
      </label>
    </div>
  );
}

function Options({ r }: { r: ReqView }) {
  if (r.met) return null;
  return (
    <div className="sq-gap">
      <small>{r.have === 0 ? t("squads.missingNone", { need: reqLabel(r) }) : t("squads.missingSome", { need: reqLabel(r), have: r.have })}</small>
      {r.options.length === 0 ? (
        <p className="sq-muted">{t("squads.noOptions")}</p>
      ) : (
        <ul className="sq-options">
          {r.options.map((o) => (
            <li key={`${o.kind}-${o.def_id}`} className={`sq-option ${o.kind}`}>
              <span className="sq-kind">{t(OPTION_LABEL[o.kind])}</span>
              <b>
                <Flag nation={o.nation} name={o.nation_name} size={16} /> {o.name}
              </b>
              <span className="sq-pos">
                {o.rating} · {o.pos}
              </span>
              <span className="sq-price">{o.price != null ? num(o.price) : o.source ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
      {r.unpriced > 0 && <p className="sq-muted">{t("squads.unpriced", { count: r.unpriced })}</p>}
    </div>
  );
}

/** The objectives of an event: ✓ met by the squad, ✕ missed, ? not readable, · nothing about the squad. */
export function Checklist({ e, compact = false }: { e: EventPlan; compact?: boolean }) {
  return (
    <ul className={`sq-checklist ${compact ? "compact" : ""}`}>
      {e.objectives.map((o, i) => {
        const r = o.req != null ? e.reqs[o.req] : null;
        const state = o.done ? "done" : r ? (r.met ? "met" : "miss") : o.unknown ? "unknown" : "plain";
        if (compact && (state === "plain" || state === "done")) return null;
        return (
          <li key={i} className={`sq-obj ${state}`}>
            <span className="sq-mark" aria-hidden="true">
              {state === "met" || state === "done" ? "✓" : state === "miss" ? "✕" : state === "unknown" ? "?" : "·"}
            </span>
            <div>
              {compact && r ? <b>{reqLabel(r)}</b> : <b>{o.name}</b>}
              {!compact && <p>{o.text}</p>}
              {r && !o.done && (
                <small className="sq-req">
                  {!compact && <>{reqLabel(r)} · </>}
                  {t("squads.have", { have: Math.min(r.have, r.count), count: r.count })}
                  {r.players.length > 0 && <> – {r.players.slice(0, compact ? 3 : 4).join(", ")}</>}
                </small>
              )}
              {o.unknown && !o.done && <small className="sq-req warn">{t("squads.notRead", { text: o.unknown })}</small>}
            </div>
            {!compact && <span className="sq-progress">{o.done ? t("squads.objDone") : `${o.progress}/${o.target}`}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function CardDetail({ s, e, onClose }: { s: SlotView; e: EventPlan; onClose: () => void }) {
  return (
    <div className="sq-detail" role="dialog" aria-label={s.name}>
      <header>
        <Flag nation={s.nation} name={s.nation_name} size={22} />
        <b>{s.name}</b>
        <span>
          {s.pos} · {s.rating}
        </span>
        <button className="sq-close" onClick={onClose} aria-label={t("squads.close")}>
          ✕
        </button>
      </header>
      <dl>
        <dt>{t("squads.detail.rating")}</dt>
        <dd>
          <span className="sq-gem" aria-hidden="true" />
          {s.strength.toFixed(1)} {!s.full && <small>{t("squads.detail.face")}</small>}
        </dd>
        <dt>{t("squads.detail.bio")}</dt>
        <dd>
          <Bio s={s} long />
        </dd>
        <dt>{t("squads.detail.chem")}</dt>
        <dd>{s.chem} / 3</dd>
        {s.accel && (
          <>
            <dt>AcceleRATE</dt>
            <dd>{t(ACCEL[s.accel] ?? "squads.accel.controlled")}</dd>
          </>
        )}
        {s.full && (
          <>
            <dt>{t("squads.detail.playstyles")}</dt>
            <dd>{t("squads.detail.psCount", { count: s.key_ps, plus: s.key_ps_plus })}</dd>
          </>
        )}
        <dt>{t("squads.detail.counts")}</dt>
        <dd>{s.counts_for.length ? s.counts_for.map((i) => reqLabel(e.reqs[i])).join(" · ") : t("squads.detail.free")}</dd>
        {s.loan && (
          <>
            <dt>{t("squads.loan")}</dt>
            <dd>✓</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** The XI on a pitch, attack at the top; a card opens its details. */
export function Pitch({ e, compact = false }: { e: EventPlan; compact?: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const sq = e.squad;
  useEffect(() => setOpen(null), [e.id]);
  if (!sq) return <p className="sq-muted">{t("squads.noSquad")}</p>;
  const shown = sq.slots.find((s) => s.def_id === open) ?? null;
  return (
    <div className={`sq-squad ${compact ? "compact" : ""}`}>
      <div className="sq-squad-head">
        <b>{sq.formation}</b>
        <span className={sq.chem >= sq.chem_target ? "ok" : "short"}>{t("squads.chem", { chem: sq.chem, target: sq.chem_target })}</span>
        <span>
          <span className="sq-gem" aria-hidden="true" />
          {t("squads.avg", { value: sq.strength.toFixed(1) })}
        </span>
        {sq.changes != null && !compact && <span>{t("squads.changes", { count: sq.changes })}</span>}
      </div>
      {sq.must_missing.length > 0 && <p className="sq-muted warn">{t("squads.must.missing", { names: sq.must_missing.join(", ") })}</p>}
      <div className="sq-pitch">
        {pitchRows(sq.slots).map((row, k) => (
          <div className="sq-line" key={k}>
            {row.map((s) => (
              <button
                key={`${s.pos}-${s.def_id}`}
                className={`sq-card ${s.counts_for.length ? "counts" : ""} ${s.must ? "must" : ""} ${open === s.def_id ? "open" : ""}`}
                title={s.counts_for.map((i) => reqLabel(e.reqs[i])).join(" · ")}
                aria-expanded={open === s.def_id}
                onClick={() => setOpen(open === s.def_id ? null : s.def_id)}
              >
                <span className="sq-card-top">
                  <b>{s.rating}</b>
                  <Flag nation={s.nation} name={s.nation_name} size={compact ? 14 : 18} />
                  <span>{s.pos}</span>
                </span>
                <span className="sq-name">{s.name || "?"}</span>
                {!compact && <Bio s={s} />}
                <span className="sq-chem-dots" aria-label={t("squads.cardChem", { chem: s.chem })}>
                  {[0, 1, 2].map((d) => (
                    <i key={d} className={d < s.chem ? "on" : ""} />
                  ))}
                </span>
                {s.loan && <span className="sq-loan">{t("squads.loan")}</span>}
                {!s.owned && <span className="sq-toget">{t("squads.toGet")}{s.price != null ? ` · ${num(s.price)}` : ""}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      {shown && <CardDetail s={shown} e={e} onClose={() => setOpen(null)} />}
    </div>
  );
}

function EventTabs({ list, current, pick }: { list: EventPlan[]; current: EventPlan; pick: (id: number) => void }) {
  return (
    <nav className="sq-events" aria-label={t("squads.events")}>
      {list.map((e) => {
        const met = e.squad ? e.squad.met : 0;
        return (
          <button key={e.id} className={`sq-event-tab ${e.id === current.id ? "active" : ""}`} aria-pressed={e.id === current.id} onClick={() => pick(e.id)}>
            <span className="sq-event-name">{e.title}</span>
            <small className={met === e.reqs.length ? "ok" : ""}>
              {met}/{e.reqs.length} · {endsIn(e.ends_at) ?? ""}
            </small>
          </button>
        );
      })}
    </nav>
  );
}

function Event({ e }: { e: EventPlan }) {
  const ends = endsIn(e.ends_at);
  return (
    <article className="sq-event">
      <header className="sq-event-head">
        <div>
          <h3>{e.title}</h3>
          <small>
            {t("squads.done", { done: e.done, total: e.total })}
            {ends && <> · {t("squads.ends", { time: ends })}</>}
          </small>
        </div>
        <SaveButton e={e} />
        {e.squad && (
          <div className="sq-score">
            <b className={e.squad.met === e.reqs.length ? "ok" : ""}>
              {e.squad.met}/{e.reqs.length}
            </b>
            <small>{t("squads.reqsMet")}</small>
          </div>
        )}
      </header>
      <div className="sq-split">
        <div className="sq-col">
          <Checklist e={e} />
        </div>
        <div className="sq-col">
          <Pitch e={e} />
          {e.reqs.filter((r) => !r.met).map((r, i) => (
            <Options key={i} r={r} />
          ))}
        </div>
      </div>
    </article>
  );
}

function Notes({ view, busy }: { view: SquadsView; busy: boolean }) {
  return (
    <>
      {busy && <p className="ml-loading">{t("squads.building", { count: view.club_players })}</p>}
      {view.needs_sync ? (
        <div className="sq-empty">
          <b>{t("squads.needsSync.title")}</b>
          <p>{t(IS_WEB ? "squads.needsSync.web" : "squads.needsSync.body")}</p>
        </div>
      ) : (
        <>
          {view.names_missing && <p className="sq-muted warn">{t("squads.namesMissing")}</p>}
          {view.events.length === 0 && <p className="sq-muted">{t("squads.none")}</p>}
        </>
      )}
    </>
  );
}

export default function Squads() {
  const [view, busy, setPrefs] = useSquads();
  const [current, pick] = useEventChoice(view);
  const [settings, setSettings] = useState(false);
  if (!view) return <p className="ml-loading">{t("squads.loading")}</p>;
  const prefs = view.prefs ?? defaultSquadPrefs;
  return (
    <section className="sq">
      <header className="sq-head">
        <div>
          <h2 className="sq-title">{t("squads.title")}</h2>
          <small className="sq-muted">
            {view.read_at ? t("squads.read", { age: formatAge(view.read_at) }) : t("squads.notYet")} · {t("squads.ratingBeta")}
          </small>
        </div>
        <button className={`cat-tab ${settings ? "active" : ""}`} aria-expanded={settings} onClick={() => setSettings(!settings)}>
          {t("squads.settings")} · {t("squads.chemShort", { value: prefs.chem_target })}
        </button>
      </header>
      {settings && <Settings prefs={prefs} onChange={setPrefs} />}
      {!view.needs_sync && view.club.length > 0 && <MustPick view={view} prefs={prefs} onChange={setPrefs} />}
      <Notes view={view} busy={busy} />
      {current && (
        <>
          {view.events.length > 1 && <EventTabs list={view.events} current={current} pick={pick} />}
          <Event e={current} />
        </>
      )}
      <SavedSquads />
    </section>
  );
}

/** The side panel's quick overview: the event the game shows (or the last picked) – what's met,
 *  what's missing and the XI, all in one narrow column. */
export function SquadQuick() {
  const [view, busy] = useSquads();
  const [current, pick] = useEventChoice(view);
  if (!view) return <p className="ml-empty ml-loading">{t("squads.loading")}</p>;
  return (
    <div className="ml-frame sq-quick">
      <header className="ml-head">
        <span className="eyebrow">{t("squads.tab")}</span>
        {current ? (
          // arrows, not a dropdown: the side panel never takes the focus a dropdown needs
          <div className="sq-pick" role="group" aria-label={t("squads.events")}>
            {view.events.length > 1 && (
              <button onClick={() => pick(view.events[(view.events.indexOf(current) - 1 + view.events.length) % view.events.length].id)} aria-label={t("squads.prevEvent")}>
                ‹
              </button>
            )}
            <h1 className="ml-title">{current.title}</h1>
            {view.events.length > 1 && (
              <button onClick={() => pick(view.events[(view.events.indexOf(current) + 1) % view.events.length].id)} aria-label={t("squads.nextEvent")}>
                ›
              </button>
            )}
          </div>
        ) : null}
      </header>
      <Notes view={view} busy={busy} />
      {current && (
        <>
          <Checklist e={current} compact />
          <Pitch e={current} compact />
          {current.reqs.filter((r) => !r.met).map((r, i) => (
            <Options key={i} r={r} />
          ))}
        </>
      )}
    </div>
  );
}
