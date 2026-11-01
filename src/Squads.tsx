// Objective squads (beta, SQUADS.md): "What are you playing?" – Auto (the most objectives at once)
// or one event the user picks (the event hub the game shows picks it too). A play session is a
// place (a mode or one live event), the XI for it from the user's own club and every open
// objective a match there moves on, across events; what needs another place is listed apart.
// Below, every event with its checklist (mark done by hand). The same view in the app overlay and
// on FC-Tracker Web; the side panel shows the quick version (SquadQuick).
import { useEffect, useRef, useState } from "react";
import { api, events, formatAge, IS_WEB } from "./api";
import { num } from "./format";
import { Flag } from "./flags";
import { t, type MessageKey } from "./i18n";
import { defaultSquadPrefs, pitchRows, type ClubEntry, type EventPlan, type GetOption, type Mode, type ObjectiveView, type ReqView, type SessionItem, type SessionPlan, type SlotView, type SquadPrefs, type SquadView, type SquadsView, sameMode } from "./squadsData";
import { removeSquad, saveSquad, useSavedSquads } from "./savedSquads";
import { voteAvailability } from "./objectives";

/** The XI as built now, kept to build later (in the game, from the dashboard, on another device). */
function SaveButton({ e }: { e: Pick<EventPlan, "id" | "title" | "squad" | "reqs"> }) {
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
    // a sync brings new objectives and club cards – one rebuild when its pages settle, not one per
    // page (the view kept jumping while a sync ran)
    let timer = 0;
    const un = events.onGalleryUpdated(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 1500);
    });
    // a match counted, the hub of an event seen: the plan moves on
    const un2 = events.onSquadsChanged(() => load());
    return () => {
      window.clearTimeout(timer);
      un.then((u) => u());
      un2.then((u) => u());
    };
  }, []);
  const setPrefs = (p: SquadPrefs) => {
    setView((v) => (v ? { ...v, prefs: p } : v));
    api.setSquadPrefs(p).then(load).catch(() => {});
  };
  // the game shows an event's hub: that's what the user plays now (they can pick another)
  const latest = useRef(view);
  latest.current = view;
  useEffect(() => {
    const un = events.onSquadsFocus((id) => {
      const v = latest.current;
      if (v && v.prefs.primary !== id && v.events.some((e) => e.id === id)) setPrefs({ ...v.prefs, primary: id, place: null });
    });
    return () => {
      un.then((u) => u());
    };
  }, []);
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
    case "weak_foot":
      return t("squads.need.weakFoot", { count: r.count, name: r.name });
    case "skill_moves":
      return t("squads.need.skillMoves", { count: r.count, name: r.name });
    case "chemistry":
      return t("squads.need.chemistry", { name: r.name });
    case "accel":
      return t("squads.need.accel", { count: r.count, name: ACCEL[r.name] ? t(ACCEL[r.name]) : r.name });
    case "playstyle":
      return t("squads.need.playstyle", { count: r.count, name: r.name.replace(/\b\w/g, (c) => c.toUpperCase()) });
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
  search: "squads.slot.search",
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

const GOALS: [string, MessageKey][] = [
  ["progress", "squads.goal.progress"],
  ["buys", "squads.goal.buys"],
  ["changes", "squads.goal.changes"],
  ["matches", "squads.goal.matches"],
];
const BUYS: [number | null, MessageKey][] = [
  [0, "squads.buys.none"],
  [1, "squads.buys.one"],
  [3, "squads.buys.three"],
  [5, "squads.buys.five"],
  [null, "squads.buys.any"],
];
type ChemPreset = "none" | "balanced" | "high";
const chemPreset = (p: SquadPrefs): ChemPreset | null => (p.chem_target === 0 ? "none" : p.chem_target === 33 && !p.chem_first ? "balanced" : p.chem_target === 33 && p.chem_first ? "high" : null);

/** A row of choices: the label, then the options (one pressed). */
function Choice<T>({ label, options, value, onPick }: { label: string; options: [T, string][]; value: T | null; onPick: (v: T) => void }) {
  return (
    <div className="sq-choice" role="radiogroup" aria-label={label}>
      <span className="sq-choice-label">{label}</span>
      {options.map(([v, text]) => (
        <button key={String(v)} className={`cat-tab ${value === v ? "active" : ""}`} aria-pressed={value === v} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Settings({ prefs, onChange, formations }: { prefs: SquadPrefs; onChange: (p: SquadPrefs) => void; formations: string[] }) {
  const [chem, setChem] = useState(prefs.chem_target);
  useEffect(() => setChem(prefs.chem_target), [prefs.chem_target]);
  const commit = () => chem !== prefs.chem_target && onChange({ ...prefs, chem_target: chem });
  const preset = chemPreset(prefs);
  return (
    <div className="sq-settings" role="group" aria-label={t("squads.settings")}>
      <Choice label={t("squads.goal.label")} options={GOALS.map(([v, k]) => [v, t(k)])} value={prefs.goal ?? "progress"} onPick={(goal) => onChange({ ...prefs, goal })} />
      <Choice<ChemPreset>
        label={t("squads.chemPreset.label")}
        options={[
          ["none", t("squads.chemPreset.none")],
          ["balanced", t("squads.chemPreset.balanced")],
          ["high", t("squads.chemPreset.high")],
        ]}
        value={preset}
        onPick={(v) => onChange({ ...prefs, chem_target: v === "none" ? 0 : 33, chem_first: v === "high" })}
      />
      <label className="sq-chem">
        <span>{t("squads.chemTarget", { value: chem })}</span>
        <input type="range" min={0} max={33} value={chem} onChange={(e) => setChem(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
      </label>
      <Choice label={t("squads.buys.label")} options={BUYS.map(([v, k]) => [v, t(k)])} value={prefs.max_buys === undefined ? 3 : prefs.max_buys} onPick={(max_buys) => onChange({ ...prefs, max_buys })} />
      <label className="sq-choice">
        <span className="sq-choice-label">{t("squads.formation")}</span>
        <select className="sq-select" value={prefs.formation ?? ""} onChange={(e) => onChange({ ...prefs, formation: e.target.value || null })}>
          <option value="">{t("squads.formationAuto")}</option>
          {formations.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      {!IS_WEB && (
        <label className="sq-check">
          <input type="checkbox" checked={prefs.track !== false} onChange={(e) => onChange({ ...prefs, track: e.target.checked })} />
          <span>{t("squads.track")}</span>
        </label>
      )}
      <label className="sq-check">
        <input type="checkbox" checked={prefs.hide_loans} onChange={(e) => onChange({ ...prefs, hide_loans: e.target.checked })} />
        <span>{t("squads.hideLoans")}</span>
      </label>
    </div>
  );
}

/** The unmet requirements, each once (several objectives often ask for the same). */
function gaps(reqs: ReqView[], skip: Set<number> = new Set()): ReqView[] {
  const seen = new Set<string>();
  return reqs.filter((r, i) => {
    const k = reqLabel(r);
    if (r.met || skip.has(i) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Requirements the user is asked about ("still available?") get no options box. */
const asked = (s: SessionPlan) => new Set(s.items.filter((x) => x.ask && x.req != null).map((x) => x.req as number));

const OPTION_SEARCH = "search";

/** What a gap is: what the club has for it, and how many more to get. */
function gapLine(r: ReqView): string {
  const need = reqLabel(r);
  const club = r.club ?? 0;
  const more = Math.max(0, r.count - club);
  if (club === 0) return t("squads.missingNone", { need });
  if (more > 0) return t("squads.missingClub", { need, count: club, names: (r.club_players ?? []).join(", "), more });
  return t("squads.missingFit", { need, names: (r.club_players ?? []).join(", ") });
}

function Options({ r }: { r: ReqView }) {
  if (r.met) return null;
  return (
    <div className="sq-gap">
      <small>{gapLine(r)}</small>
      {r.options.length === 0 ? (
        <p className="sq-muted">{t("squads.noOptions")}</p>
      ) : (
        <ul className="sq-options">
          {r.options.map((o) => (
            <li key={`${o.kind}-${o.def_id}`} className={`sq-option ${o.kind}`}>
              <span className="sq-kind">{o.kind === OPTION_SEARCH ? t("squads.slot.search") : t(OPTION_LABEL[o.kind])}</span>
              <b>
                <Flag nation={o.nation} name={o.nation_name} size={16} /> {o.name}
              </b>
              <span className="sq-pos">
                {o.rating} · {o.pos}
              </span>
              <span className="sq-price">{o.price != null ? num(o.price) : o.source ?? (o.kind === OPTION_SEARCH ? t("squads.noPrice") : "")}</span>
            </li>
          ))}
        </ul>
      )}
      {r.unpriced > 0 && <p className="sq-muted">{t("squads.unpriced", { count: r.unpriced })}</p>}
    </div>
  );
}

/** "Is it still available?" – asked once per requirement no card we know meets; the answer is the
 *  user's (and one vote towards a fact every user gets). */
function AskCards({ s, prefs, onPrefs }: { s: SessionPlan; prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void }) {
  const names = Array.from(new Set(s.items.map((x) => x.ask).filter((x): x is string => !!x)));
  if (names.length === 0) return null;
  const answer = (name: string, yes: boolean) => {
    const keep = (prefs.keep ?? []).filter((k) => k !== name);
    const skip = (prefs.skip ?? []).filter((k) => k !== name);
    onPrefs({ ...prefs, keep: yes ? [...keep, name] : keep, skip: yes ? skip : [...skip, name] });
    void voteAvailability(name, yes);
  };
  const title = (n: string) => n.replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <>
      {names.map((n) => (
        <div className="sq-ask" key={n} role="group" aria-label={t("squads.ask.title", { name: title(n) })}>
          <div>
            <b>{t("squads.ask.title", { name: title(n) })}</b>
            <small>{t("squads.ask.body", { count: s.items.filter((x) => x.ask === n).length })}</small>
          </div>
          <button className="cat-tab" onClick={() => answer(n, true)}>
            {t("squads.ask.yes")}
          </button>
          <button className="cat-tab" onClick={() => answer(n, false)}>
            {t("squads.ask.no")}
          </button>
        </div>
      ))}
    </>
  );
}

/** The objectives of an event: ✓ met by the squad, ✕ missed, ? not readable, · nothing about the squad. */
export function Checklist({ e, compact = false, onMark }: { e: EventPlan; compact?: boolean; onMark?: (o: ObjectiveView) => void }) {
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
              {!o.playable && !o.done && !compact && <small className="sq-req">{t("squads.notPlayed")}</small>}
            </div>
            {!compact && (
              <span className="sq-progress">
                {o.done ? t("squads.objDone") : `${o.progress}/${o.target}`}
                {onMark && (
                  <button className="sq-mark-btn" title={o.marked ? t("squads.markedHint") : undefined} onClick={() => onMark(o)}>
                    {o.marked ? t("squads.unmark") : o.done ? t("squads.markOpen") : t("squads.markDone")}
                  </button>
                )}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

type SquadSource = Pick<EventPlan, "id" | "reqs" | "squad">;

/** What a card is in this squad: in the club, to buy (with EA's price), or a profile to search for. */
function slotKind(s: SlotView): string {
  if (s.owned) return "";
  if (s.generic) return t("squads.slot.searchAny", { pos: s.pos });
  return s.price != null ? t("squads.slot.buy", { price: num(s.price) }) : t("squads.toGet");
}

function CardDetail({ s, e, onClose }: { s: SlotView; e: SquadSource; onClose: () => void }) {
  return (
    <div className="sq-detail" role="dialog" aria-label={s.name}>
      <header>
        <Flag nation={s.nation} name={s.nation_name} size={22} />
        <b>{s.generic ? t("squads.slot.profile", { nation: s.nation_name ?? "", league: s.league_name ?? "" }) : s.name}</b>
        <span>
          {s.pos} · {s.rating}
        </span>
        <button className="sq-close" onClick={onClose} aria-label={t("squads.close")}>
          ✕
        </button>
      </header>
      <dl>
        {!s.owned && (
          <>
            <dt>{t("squads.slot.get")}</dt>
            <dd>{s.generic ? t("squads.slot.searchLong", { pos: s.pos, nation: s.nation_name ?? "", league: s.league_name ?? "", name: s.name }) : slotKind(s)}</dd>
          </>
        )}
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
        <dd>
          {s.chem} / 3 {s.out_of_position && <small className="warn">{t("squads.slot.oopLong")}</small>}
        </dd>
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

/** The manager by nation and league only (user 2026-10-31): the squad's, or the one that adds chemistry. */
function ManagerLine({ sq }: { sq: SquadView }) {
  const m = sq.manager;
  if (!m) return null;
  return (
    <p className={`sq-manager ${m.current ? "" : "tip"}`}>
      <span className="sq-choice-label">{t("squads.manager")}</span>
      <Flag nation={m.nation} name={m.nation_name} size={16} /> {m.nation_name ?? ""} · {m.league_name ?? ""}
      <small>{m.current ? t("squads.managerNow") : t("squads.managerTip", { gain: m.gain })}</small>
    </p>
  );
}

/** The XI on a pitch, attack at the top; a card opens its details. */
export function Pitch({ e, compact = false }: { e: SquadSource; compact?: boolean }) {
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
        {sq.buys > 0 && <span className="short">{sq.cost > 0 ? t("squads.buysCost", { count: sq.buys, coins: num(sq.cost) }) : t("squads.buysCount", { count: sq.buys })}</span>}
      </div>
      {sq.must_missing.length > 0 && <p className="sq-muted warn">{t("squads.must.missing", { names: sq.must_missing.join(", ") })}</p>}
      <div className="sq-pitch">
        {pitchRows(sq.slots).map((row, k) => (
          <div className="sq-line" key={k}>
            {row.map((s) => (
              <button
                key={`${s.pos}-${s.def_id}`}
                className={`sq-card ${s.counts_for.length ? "counts" : ""} ${s.must ? "must" : ""} ${!s.owned ? "buy" : ""} ${s.out_of_position ? "oop" : ""} ${open === s.def_id ? "open" : ""}`}
                title={s.counts_for.map((i) => reqLabel(e.reqs[i])).join(" · ")}
                aria-expanded={open === s.def_id}
                onClick={() => setOpen(open === s.def_id ? null : s.def_id)}
              >
                <span className="sq-card-top">
                  <b>{s.rating}</b>
                  <Flag nation={s.nation} name={s.nation_name} size={compact ? 14 : 18} />
                  <span>{s.pos}</span>
                </span>
                <span className="sq-name">{s.generic ? t("squads.slot.eg", { name: s.name }) : s.name || "?"}</span>
                {!compact && !s.generic && <Bio s={s} />}
                <span className="sq-chem-dots" aria-label={t("squads.cardChem", { chem: s.chem })}>
                  {[0, 1, 2].map((d) => (
                    <i key={d} className={d < s.chem ? "on" : ""} />
                  ))}
                </span>
                {s.loan && <span className="sq-loan">{t("squads.loan")}</span>}
                {s.out_of_position && <span className="sq-oop">{t("squads.slot.oop")}</span>}
                {!s.owned && <span className="sq-toget">{slotKind(s)}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>
      {!compact && <ManagerLine sq={sq} />}
      {shown && <CardDetail s={shown} e={e} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Event({ e, prefs, onPrefs }: { e: EventPlan; prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void }) {
  const ends = endsIn(e.ends_at);
  // a hand mark counts until the next sync reads the objective; clicking a marked one takes it back
  const mark = (o: ObjectiveView) => {
    const marks = (prefs.done_marks ?? []).filter((m) => !(m.group === e.id && m.objective === o.id));
    if (!o.marked) marks.push({ group: e.id, objective: o.id, done: !o.done, at: Date.now() });
    onPrefs({ ...prefs, done_marks: marks });
  };
  return (
    <article className="sq-event">
      <header className="sq-event-head">
        <div>
          <h3>{e.title}</h3>
          <small>
            {e.category && <>{e.category} · </>}
            {t("squads.done", { done: e.done, total: e.total })}
            {ends && <> · {t("squads.ends", { time: ends })}</>}
          </small>
        </div>
        {e.squad && <SaveButton e={e} />}
        {e.squad && (
          <div className="sq-score">
            <b className={e.squad.met === e.reqs.length ? "ok" : ""}>
              {e.squad.met}/{e.reqs.length}
            </b>
            <small>{t("squads.reqsMet")}</small>
          </div>
        )}
      </header>
      <div className={e.squad ? "sq-split" : ""}>
        <div className="sq-col">
          <Checklist e={e} onMark={mark} />
        </div>
        {e.squad && (
          <div className="sq-col">
            <Pitch e={e} />
            {gaps(e.reqs).map((r, i) => (
              <Options key={i} r={r} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

const PLACE: Record<string, MessageKey> = {
  squad_battles: "squads.place.squad_battles",
  rivals: "squads.place.rivals",
  champions: "squads.place.champions",
  rush: "squads.place.rush",
  draft: "squads.place.draft",
  co_op: "squads.place.co_op",
  live_events: "squads.place.live_events",
  any: "squads.place.any",
};

/** A place as the user knows it: a live event by its title, a mode by its name. */
export function placeLabel(m: Mode, name: string): string {
  return m.kind === "event" ? name : t(PLACE[m.kind]);
}
const placeName = (n: string) => (PLACE[n] ? t(PLACE[n]) : n);

type Filter = "live" | "done" | "all";
const FILTER_PREF = "fct.squads.filter";

/** Events in EA's own categories and order (user 2026-10-31: "exactly like EA has them"). */
function byCategory(list: EventPlan[]): { name: string; events: EventPlan[] }[] {
  const groups: { name: string; id: number; events: EventPlan[] }[] = [];
  for (const e of list) {
    const name = e.category || t("squads.categoryOther");
    const g = groups.find((x) => x.name === name);
    if (g) g.events.push(e);
    else groups.push({ name, id: e.category_id ?? 999, events: [e] });
  }
  return groups.sort((a, b) => a.id - b.id);
}

const isDone = (e: EventPlan) => e.total > 0 && e.done >= e.total;

/** The live / completed / all filter – the selectors below follow it. */
function useFilter(): [Filter, (f: Filter) => void] {
  const [f, setF] = useState<Filter>(() => {
    try {
      const v = localStorage.getItem(FILTER_PREF);
      return v === "done" || v === "all" ? v : "live";
    } catch {
      return "live";
    }
  });
  const set = (v: Filter) => {
    setF(v);
    try {
      localStorage.setItem(FILTER_PREF, v);
    } catch {}
  };
  return [f, set];
}

function filtered(list: EventPlan[], f: Filter): EventPlan[] {
  return list.filter((e) => (f === "done" ? isDone(e) : f === "live" ? e.live && !isDone(e) : true));
}

function FilterChips({ value, onPick, view }: { value: Filter; onPick: (f: Filter) => void; view: SquadsView }) {
  const count = (f: Filter) => filtered(view.events, f).length;
  return (
    <div className="sq-filter" role="radiogroup" aria-label={t("squads.filter.label")}>
      {(["live", "done", "all"] as Filter[]).map((f) => (
        <button key={f} className={`cat-tab ${value === f ? "active" : ""}`} aria-pressed={value === f} onClick={() => onPick(f)}>
          {t(f === "live" ? "squads.filter.live" : f === "done" ? "squads.filter.done" : "squads.filter.all")} · {count(f)}
        </button>
      ))}
    </div>
  );
}

/** One dropdown for many events, in EA's categories – no row that runs off the screen. */
function EventSelect({ list, value, onPick, auto, label }: { list: EventPlan[]; value: number | null; onPick: (id: number | null) => void; auto?: string; label: string }) {
  const groups = byCategory(list);
  const known = value != null && list.some((e) => e.id === value);
  return (
    <select className="sq-select sq-event-select" aria-label={label} value={value == null ? "" : String(value)} onChange={(e) => onPick(e.target.value === "" ? null : Number(e.target.value))}>
      {auto != null && <option value="">{auto}</option>}
      {!known && value != null && <option value={String(value)}>{t("squads.filter.hidden")}</option>}
      {groups.map((g) => (
        <optgroup key={g.name} label={g.name}>
          {g.events.map((e) => (
            <option key={e.id} value={String(e.id)}>
              {e.title} · {isDone(e) ? t("squads.objDone") : `${e.done}/${e.total}`}
              {endsIn(e.ends_at) && e.live ? ` · ${endsIn(e.ends_at)}` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** "What are you playing?": Auto (the most objectives at once) or one event – and where. */
function PlayPick({ view, prefs, onPrefs, filter }: { view: SquadsView; prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void; filter: Filter }) {
  const first = view.combos[0];
  const list = filtered(view.events, filter).filter((e) => e.playable);
  return (
    <div className="sq-play">
      <label className="sq-choice">
        <span className="sq-choice-label">{t("squads.play.title")}</span>
        <EventSelect list={list} value={view.primary ?? prefs.primary ?? null} auto={`${t("squads.play.auto")} – ${t("squads.play.autoHint")}`} label={t("squads.play.title")} onPick={(primary) => onPrefs({ ...prefs, primary, place: null })} />
      </label>
      {view.primary != null && view.places.length > 1 && (
        <div className="sq-choice" role="radiogroup" aria-label={t("squads.play.where")}>
          <span className="sq-choice-label">{t("squads.play.where")}</span>
          {view.places.map((p) => {
            const on = sameMode(p.place, prefs.place ?? first?.place);
            return (
              <button key={JSON.stringify(p.place)} className={`cat-tab ${on ? "active" : ""}`} aria-pressed={on} onClick={() => onPrefs({ ...prefs, place: p.place })}>
                {placeLabel(p.place, p.name)} · {p.objectives}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A session's objectives by event: ✓ counts with this squad, ✕ needs a card, ? not readable. */
export function SessionList({ s, compact = false, elsewhere }: { s: SessionPlan; compact?: boolean; elsewhere?: Map<string, SessionPlan> }) {
  const groups: { title: string; items: SessionItem[] }[] = [];
  for (const it of s.items.filter((x) => !x.bonus)) {
    const g = groups.find((x) => x.title === it.event_title);
    if (g) g.items.push(it);
    else groups.push({ title: it.event_title, items: [it] });
  }
  // the picked event first, then what counts; what needs a card or can't be read at the end
  const score = (g: { items: SessionItem[] }) => (g.items.some((x) => x.event === s.primary) ? 2 : 0) + (g.items.some((x) => x.counts) ? 1 : 0);
  groups.sort((a, b) => score(b) - score(a));
  for (const g of groups) g.items.sort((a, b) => Number(b.counts) - Number(a.counts));
  const bonus = s.items.filter((x) => x.bonus && x.counts);
  const row = (o: SessionItem) => {
    const r = o.req != null ? s.reqs[o.req] : null;
    const other = !o.counts ? elsewhere?.get(`${o.event}-${o.objective}`) : undefined;
    const state = o.counts ? "met" : other ? "plain" : o.unknown || o.ask ? "unknown" : "miss";
    return (
      <li key={`${o.event}-${o.objective}`} className={`sq-obj ${state}`}>
        <span className="sq-mark" aria-hidden="true">
          {state === "met" ? "✓" : state === "miss" ? "✕" : state === "plain" ? "→" : "?"}
        </span>
        <div>
          {compact ? <b>{o.text}</b> : <b>{o.name || o.text}</b>}
          {!compact && o.name && <p>{o.text}</p>}
          {other ? (
            <small className="sq-req">{t("squads.play.elsewhere", { id: other.id, count: other.quick ?? 1 })}</small>
          ) : o.ask ? (
            <small className="sq-req warn">{t("squads.ask.waiting")}</small>
          ) : r ? (
            <small className="sq-req">
              {reqLabel(r)} · {t("squads.have", { have: Math.min(r.have, r.count), count: r.count })}
              {r.players.length > 0 && <> – {r.players.slice(0, 3).join(", ")}</>}
              {o.scorer && <> · {t("squads.play.scorer")}</>}
            </small>
          ) : o.unknown ? (
            <small className="sq-req warn">{t("squads.notRead", { text: o.unknown })}</small>
          ) : (
            <small className="sq-req">{t("squads.play.anySquad")}</small>
          )}
        </div>
        {!compact && (
          <span className="sq-progress">
            {`${o.progress}/${o.target}`}
            {o.matches != null && o.counts && o.matches >= 0.5 && o.matches < 500 && <small>{t("squads.plan.about", { count: Math.max(1, Math.round(o.matches)) })}</small>}
          </span>
        )}
      </li>
    );
  };
  return (
    <div className="sq-session-list">
      {groups.map((g) => (
        <section key={g.title} className="sq-session-group">
          <h4>{g.title}</h4>
          <ul className={`sq-checklist ${compact ? "compact" : ""}`}>{g.items.map(row)}</ul>
        </section>
      ))}
      {bonus.length > 0 && (
        <details className="sq-bonus">
          <summary>{t("squads.play.bonus", { count: bonus.length })}</summary>
          <ul className="sq-checklist compact">{bonus.map(row)}</ul>
        </details>
      )}
    </div>
  );
}

function sessionEvents(s: SessionPlan): number {
  return new Set(s.items.filter((x) => x.counts && !x.bonus).map((x) => x.event)).size;
}

/** The match plan: squads in turn, the changes between them, where the user is now. */
function MatchPlan({ s, stage, onStage, quick, onPick }: { s: SessionPlan; stage: number; onStage: (k: number) => void; quick: SessionPlan[]; onPick: (id: number) => void }) {
  if (s.stages.length === 0 && quick.length === 0) return null;
  const next = s.played + 1;
  return (
    <section className="sq-plan" aria-label={t("squads.plan.title")}>
      <h4>{t("squads.plan.title")}</h4>
      {s.played > 0 && <p className="sq-muted">{t("squads.plan.played", { count: s.played })}</p>}
      <ol>
        {s.stages.map((st, k) => {
          const now = st.from <= next && (st.to == null || next <= st.to);
          return (
            <li key={k} className={`${now ? "now" : ""} ${stage === k ? "open" : ""}`}>
              {st.swaps.length > 0 && (
                <div className="sq-plan-swap">
                  <b>{t("squads.plan.after", { count: st.from - 1 })}</b>
                  {st.swaps.map((w, i) => (
                    <span key={i}>
                      {w.out_name ? t("squads.plan.swap", { out: w.out_name, in: w.in_name, pos: w.pos }) : t("squads.plan.in", { in: w.in_name, pos: w.pos })}
                      {!w.in_owned && <small> · {w.in_price != null ? t("squads.slot.buy", { price: num(w.in_price) }) : t("squads.slot.search")}</small>}
                    </span>
                  ))}
                </div>
              )}
              <button className="sq-plan-stage" aria-pressed={stage === k} onClick={() => onStage(k)}>
                <b>{st.to == null ? t("squads.plan.from", { from: st.from }) : st.from === st.to ? t("squads.plan.one", { n: st.from }) : t("squads.plan.range", { from: st.from, to: st.to })}</b>
                {now && <span className="sq-now">{t("squads.plan.now")}</span>}
                {st.finishing.length > 0 && <small>{t("squads.plan.finishes", { names: st.finishing.slice(0, 4).join(", ") + (st.finishing.length > 4 ? ` +${st.finishing.length - 4}` : "") })}</small>}
              </button>
            </li>
          );
        })}
      </ol>
      {quick.map((q) => (
        <button key={q.id} className="sq-plan-stage sq-plan-quick" onClick={() => onPick(q.id)}>
          <b>{t("squads.plan.quick", { count: q.quick ?? 1, id: q.id })}</b>
          <small>{q.items.filter((x) => x.counts).map((x) => x.name || x.text).join(", ")}</small>
        </button>
      ))}
      <p className="sq-muted">{t("squads.plan.note")}</p>
    </section>
  );
}

/** Why this squad, in one line: what it clears, what it costs, what it gave up. */
function Why({ s }: { s: SessionPlan }) {
  const sq = s.squad;
  const parts = [t("squads.why.clears", { count: s.counted, events: sessionEvents(s) })];
  if (s.bonus > 0) parts.push(t("squads.why.bonus", { count: s.bonus }));
  if (sq && sq.buys > 0) parts.push(sq.cost > 0 ? t("squads.why.buys", { count: sq.buys, coins: num(sq.cost) }) : t("squads.buysCount", { count: sq.buys }));
  if (sq && sq.buys === 0) parts.push(t("squads.why.club"));
  if (sq && sq.chem < sq.chem_target) parts.push(t("squads.why.chem", { chem: sq.chem }));
  if (s.stages.length > 1) parts.push(t("squads.why.stages", { count: s.stages.length - 1 }));
  return <p className="sq-why">{parts.join(" · ")}</p>;
}

/** The sessions as tabs, the picked one (or the first) open: where, the plan, the XI, what counts. */
function Sessions({ view, prefs, onPrefs }: { view: SquadsView; prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const [stage, setStage] = useState(0);
  useEffect(() => setPicked(null), [view.primary, view.prefs.place?.kind]);
  const list = view.combos;
  const s = list.find((x) => x.id === picked) ?? list[0];
  // the stage being played now opens first
  const nowStage = s ? Math.max(0, s.stages.findIndex((st) => st.from <= s.played + 1 && (st.to == null || s.played + 1 <= st.to))) : 0;
  useEffect(() => setStage(nowStage), [s?.id, nowStage, s?.stages.length]);
  if (!s) return view.needs_sync ? null : <p className="sq-muted">{t("squads.play.none")}</p>;
  const place = placeLabel(s.place, s.place_name);
  const quick = list.filter((x) => x.quick != null);
  // objectives a short squad clears
  const elsewhere = new Map<string, SessionPlan>();
  for (const q of quick) for (const x of q.items) if (x.counts) elsewhere.set(`${x.event}-${x.objective}`, q);
  const st = s.stages[stage];
  const shown = st ? { id: s.id * 100 + stage, reqs: st.reqs, squad: st.squad } : s;
  return (
    <>
      {list.length > 1 && (
        <nav className="sq-sessions" aria-label={t("squads.play.sessions")}>
          {list.map((x) => (
            <button key={x.id} className={`sq-event-tab ${x.id === s.id ? "active" : ""}`} aria-pressed={x.id === s.id} onClick={() => setPicked(x.id)}>
              <span className="sq-event-name">
                {x.id}. {x.quick != null ? t("squads.play.quickTab", { count: x.quick }) : placeLabel(x.place, x.place_name)}
              </span>
              <small className={x.counted > 0 ? "ok" : ""}>{t("squads.play.objectives", { count: x.counted })}</small>
            </button>
          ))}
        </nav>
      )}
      <article className="sq-event sq-session">
        <header className="sq-event-head">
          <div>
            <h3>{s.quick != null ? t("squads.play.quickTitle", { count: s.quick }) : t("squads.play.session", { place })}</h3>
            <Why s={s} />
          </div>
          <SaveButton e={{ id: s.id, title: `${place} · ${s.title}`, squad: shown.squad, reqs: shown.reqs }} />
          <div className="sq-score">
            <b className="ok">{s.counted}</b>
            <small>{t("squads.play.objectivesShort")}</small>
          </div>
        </header>
        {s.place.kind === "rush" && <p className="sq-muted">{t("squads.play.rush")}</p>}
        <AskCards s={s} prefs={prefs} onPrefs={onPrefs} />
        <div className="sq-split">
          <div className="sq-col">
            <MatchPlan s={s} stage={stage} onStage={setStage} quick={s.id === list[0].id ? quick : []} onPick={setPicked} />
            <SessionList s={s} elsewhere={s.id === list[0].id ? elsewhere : undefined} />
          </div>
          <div className="sq-col">
            {s.place.kind !== "rush" && <Pitch e={shown} />}
            {s.squad && gaps(s.reqs, asked(s))
              .filter((r) => !(s.id === list[0].id && quick.some((q) => q.reqs.some((x) => x.met && reqLabel(x) === reqLabel(r)))))
              .map((r, i) => (
                <Options key={i} r={r} />
              ))}
          </div>
        </div>
      </article>
      {s.id === list[0].id && view.apart.length > 0 && (
        <details className="sq-apart">
          <summary>{t("squads.play.apart", { place, count: view.apart.length })}</summary>
          <ul>
            {view.apart.map((a) => (
              <li key={a.event}>
                <b>{a.title}</b>
                <small className="sq-muted">{t("squads.play.needs", { places: a.places.map(placeName).join(" · ") })}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Notes({ view, busy }: { view: SquadsView; busy: boolean }) {
  return (
    <>
      {busy && view.combos.length === 0 && view.events.length === 0 && <p className="ml-loading">{t("squads.building", { count: view.club_players })}</p>}
      {view.needs_sync ? (
        <div className="sq-empty">
          <b>{t("squads.needsSync.title")}</b>
          <p>{t(IS_WEB ? "squads.needsSync.web" : "squads.needsSync.body")}</p>
        </div>
      ) : (
        <>
          {view.names_missing && <p className="sq-muted warn">{t("squads.namesMissing")}</p>}
          {view.events.length === 0 && view.combos.length === 0 && <p className="sq-muted">{t("squads.none")}</p>}
        </>
      )}
    </>
  );
}

/** Every event (in EA's categories) with its checklist – mark done by hand. */
function AllEvents({ view, prefs, onPrefs, filter }: { view: SquadsView; prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void; filter: Filter }) {
  const [current, pick] = useEventChoice(view);
  const list = filtered(view.events, filter);
  const e = current && list.some((x) => x.id === current.id) ? current : list[0] ?? null;
  return (
    <section className="sq-all">
      <div className="sq-all-head">
        <h3 className="sq-section-title">{t("squads.allEvents")}</h3>
        {list.length > 0 && <EventSelect list={list} value={e?.id ?? null} label={t("squads.events")} onPick={(id) => id != null && pick(id)} />}
      </div>
      {e ? <Event e={e} prefs={prefs} onPrefs={onPrefs} /> : <p className="sq-muted">{t("squads.filter.empty")}</p>}
    </section>
  );
}

export default function Squads() {
  const [view, busy, setPrefs] = useSquads();
  const [settings, setSettings] = useState(false);
  const [filter, setFilter] = useFilter();
  if (!view) return <p className="ml-loading">{t("squads.loading")}</p>;
  const prefs = view.prefs ?? defaultSquadPrefs;
  const formations = Array.from(new Set(view.combos.flatMap((c) => (c.squad ? [c.squad.formation] : [])).concat(FORMATIONS)));
  return (
    <section className="sq">
      <header className="sq-head">
        <div>
          <h2 className="sq-title">{t("squads.title")}</h2>
          <small className="sq-muted">
            {busy ? <span className="ml-loading">{t("squads.building", { count: view.club_players })}</span> : view.read_at ? t("squads.read", { age: formatAge(view.read_at) }) : t("squads.notYet")} · {t("squads.ratingBeta")}
          </small>
        </div>
        <button className={`cat-tab ${settings ? "active" : ""}`} aria-expanded={settings} onClick={() => setSettings(!settings)}>
          {t("squads.settings")} · {t(GOALS.find(([g]) => g === (prefs.goal ?? "progress"))?.[1] ?? "squads.goal.progress")}
        </button>
      </header>
      {settings && <Settings prefs={prefs} onChange={setPrefs} formations={formations} />}
      {!view.needs_sync && view.club.length > 0 && <MustPick view={view} prefs={prefs} onChange={setPrefs} />}
      <Notes view={view} busy={busy} />
      {!view.needs_sync && (
        <div className="sq-toolbar">
          <PlayPick view={view} prefs={prefs} onPrefs={setPrefs} filter={filter} />
          <FilterChips value={filter} onPick={setFilter} view={view} />
        </div>
      )}
      <Sessions view={view} prefs={prefs} onPrefs={setPrefs} />
      {view.events.length > 0 && <AllEvents view={view} prefs={prefs} onPrefs={setPrefs} filter={filter} />}
      <SavedSquads />
    </section>
  );
}

/** The formations to pick from (EA's names, as the squad shows them). */
const FORMATIONS = ["4-3-3", "4-3-3 (2)", "4-4-2", "4-4-2 (2)", "4-2-3-1", "4-2-3-1 (2)", "4-1-2-1-2", "4-3-1-2", "4-2-2-2", "4-5-1", "4-1-4-1", "3-4-1-2", "3-5-2", "3-4-3", "5-3-2", "5-2-1-2"];

/** The side panel's quick overview: what to play now (the first session – the user's pick or
 *  Auto), the stage of the plan, what counts and the XI – one narrow column. */
export function SquadQuick() {
  const [view, busy] = useSquads();
  const [k, setK] = useState(0);
  if (!view) return <p className="ml-empty ml-loading">{t("squads.loading")}</p>;
  const list = view.combos;
  const s = list[Math.min(k, list.length - 1)] ?? null;
  const step = (d: number) => setK((Math.min(k, list.length - 1) + d + list.length) % list.length);
  const st = s?.stages.find((x) => x.from <= s.played + 1 && (x.to == null || s.played + 1 <= x.to)) ?? null;
  const shown = s && st ? { id: s.id, reqs: st.reqs, squad: st.squad } : s;
  return (
    <div className="ml-frame sq-quick">
      <header className="ml-head">
        <span className="eyebrow">{t("squads.tab")}</span>
        {s ? (
          // arrows, not a dropdown: the side panel never takes the focus a dropdown needs
          <div className="sq-pick" role="group" aria-label={t("squads.play.sessions")}>
            {list.length > 1 && (
              <button onClick={() => step(-1)} aria-label={t("squads.prevEvent")}>
                ‹
              </button>
            )}
            <h1 className="ml-title">
              {placeLabel(s.place, s.place_name)} · {t("squads.play.objectives", { count: s.counted })}
            </h1>
            {list.length > 1 && (
              <button onClick={() => step(1)} aria-label={t("squads.nextEvent")}>
                ›
              </button>
            )}
          </div>
        ) : null}
      </header>
      <Notes view={view} busy={busy} />
      {s && (
        <>
          {st && (
            <p className="sq-muted">
              {st.to == null ? t("squads.plan.from", { from: st.from }) : t("squads.plan.range", { from: st.from, to: st.to })}
              {st.to != null && <> · {t("squads.plan.nextChange", { count: Math.max(0, st.to - s.played) })}</>}
            </p>
          )}
          <SessionList s={s} compact />
          {shown && s.place.kind !== "rush" && <Pitch e={shown} compact />}
          {gaps(s.reqs, asked(s)).map((r, i) => (
            <Options key={i} r={r} />
          ))}
        </>
      )}
    </div>
  );
}
