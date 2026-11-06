// Objective squads (beta, SQUADS.md): "What are you playing?" – Auto (the most objectives at once)
// or one event the user picks (the event hub the game shows picks it too). A play session is a
// place (a mode or one live event), the XI for it from the user's own club and every open
// objective a match there moves on, across events; what needs another place is listed apart.
// Below, every event with its checklist (mark done by hand). The same view in the app overlay and
// on FC-Tracker Web; the side panel shows the quick version (SquadQuick).
import { useEffect, useRef, useState, createContext, useContext } from "react";
import { api, events, formatAge, IS_WEB, type SquadSeen } from "./api";
import { num } from "./format";
import { Flag } from "./flags";
import { t, type MessageKey } from "./i18n";
import { useSessionPick } from "./panelShare";
import { defaultSquadPrefs, pitchRows, type ClubEntry, type EventPlan, type GetOption, type Mode, type ObjectiveView, type ReqView, type SessionItem, type MatchBrief, type BriefTask, type SessionPlan, type SlotView, type SquadPrefs, type SquadView, type SquadsView, sameMode } from "./squadsData";
import { removeSquad, saveSquad, useSavedSquads } from "./savedSquads";
import { voteAvailability } from "./objectives";
import { fold } from "./search";
import { Bar, Chem, FaceChip, FutCard, Keycap, Switch, Tag, stripRef, type FutCardData } from "./ui";

/** a squad slot as an EA card (its art from the plan: rarity, club, face stats – older plans draw the plain outline) */
const slotCard = (s: SlotView): FutCardData => ({
  name: s.generic ? t("squads.slot.eg", { name: s.name }) : s.name || "?",
  rating: s.rating, position: s.positions?.[0] ?? s.pos, rareflag: s.rareflag ?? null, defId: s.def_id,
  positions: s.positions, face: s.face ?? null, nation: s.nation || null, league: s.league || null, club: s.club || null,
  foot: s.foot === 2 ? "L" : s.foot === 1 ? "R" : null, weakFoot: s.weak_foot || null, skillMoves: s.skill_moves || null, meta: s.strength,
  firstOwner: !!s.first_owner,
  actionGuid: s.art ?? null,
});

/** What the squad views may change (the overlay and the side panel; none in read-only views). */
type Edit = { prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void; club: ClubEntry[] };
const EditCtx = createContext<Edit | null>(null);

const slotKey = (s: SlotView) => s.key ?? s.def_id;

/** "Lock in squad" (user 2026-11-03, was "Save squad"): the XI shown plays the coming challenges –
 *  these cards in this formation, in every window, until unlocked. Kept in the history list too. */
function LockButton({ e, event }: { e: Pick<EventPlan, "id" | "title" | "squad" | "reqs">; event: number }) {
  const edit = useContext(EditCtx);
  if (!e.squad || !edit) return null;
  const locked = edit.prefs.locked;
  const keys = e.squad.slots.map(slotKey);
  const same = !!locked && locked.formation === e.squad.formation && keys.every((k) => locked.keys.includes(k));
  return (
    <button
      data-f
      className={same ? "btn btn-secondary ring sq-lock-btn" : "btn btn-primary sq-lock-btn"}
      aria-pressed={same}
      onClick={() => {
        if (same) return edit.onPrefs({ ...edit.prefs, locked: null });
        saveSquad(e);
        edit.onPrefs({ ...edit.prefs, locked: { event, title: e.title, formation: e.squad!.formation, keys, at: Date.now() } });
      }}
    >
      <Keycap ps="✕" xb="A" kb="Enter" />
      {same ? t("squads.lock.locked") : t("squads.lock.lock")}
    </button>
  );
}

/** While a squad is locked in: what plays, for which challenge, and the way out. */
function LockBar() {
  const edit = useContext(EditCtx);
  const l = edit?.prefs.locked;
  if (!edit || !l) return null;
  return (
    <div className="sq-lockbar" role="status">
      <span className="sq-lock-mark" aria-hidden="true" />
      <b>{t("squads.lock.bar", { formation: l.formation })}</b>
      <small title={l.title}>{t("squads.lock.for", { title: l.title.split(" · ")[0], when: formatAge(l.at) })}</small>
      <button className="cat-tab" onClick={() => edit.onPrefs({ ...edit.prefs, locked: null })}>
        {t("squads.lock.unlock")}
      </button>
    </div>
  );
}

function LeftOut() {
  const edit = useContext(EditCtx);
  const ex = edit?.prefs.exclude ?? [];
  const sw = edit?.prefs.swaps ?? [];
  const pins = edit?.prefs.pins ?? [];
  if (!edit || ex.length + sw.length + pins.length === 0) return null;
  const byKey = new Map(edit.club.map((c) => [c.key, c]));
  return (
    <p className="sq-leftout">
      {sw.length > 0 && <span className="sq-choice-label">{t("v2.sq.swapped")}</span>}
      {sw.map((w) => (
        <button key={`${w.key}-${w.pos}`} className="sq-chip" onClick={() => edit.onPrefs({ ...edit.prefs, swaps: sw.filter((x) => x !== w) })} title={t("squads.change.putBack")}>
          {byKey.get(w.key)?.name ?? `#${w.key}`} · {w.pos} <span aria-hidden="true">↺</span>
        </button>
      ))}
      {pins.length > 0 && <span className="sq-choice-label">{t("v2.sq.picked")}</span>}
      {pins.map((w) => (
        <button key={`p${w.key}-${w.pos}`} className="sq-chip" onClick={() => edit.onPrefs({ ...edit.prefs, pins: pins.filter((x) => x !== w) })} title={t("squads.change.putBack")}>
          {byKey.get(w.key)?.name ?? `#${w.key}`} · {w.pos} <span aria-hidden="true">↺</span>
        </button>
      ))}
      {ex.length > 0 && <span className="sq-choice-label">{t("squads.change.leftOut")}</span>}
      {ex.map((k) => (
        <button key={k} className="sq-chip" onClick={() => edit.onPrefs({ ...edit.prefs, exclude: ex.filter((x) => x !== k) })} title={t("squads.change.putBack")}>
          {byKey.get(k)?.name ?? `#${k}`} <span aria-hidden="true">↺</span>
        </button>
      ))}
    </p>
  );
}

/** Saved objective squads (kept on the account too): what to build, what's still to buy. */
/** One saved squad as a small card. The XI shows in a popover after a short hover or on keyboard focus, and closes on
 *  leave / blur / Esc / a click – never stuck open. × removes it, always in reach. */
function SavedCard({ s }: { s: ReturnType<typeof useSavedSquads>[number] }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 280);
  };
  // never over the card's own × (user 2026-11-05): the popover closes while the pointer is on it and opens again off it
  const onMove = (e: React.MouseEvent) => {
    const onX = !!(e.target as HTMLElement).closest(".sq-saved-x");
    if (onX) {
      if (open || timer.current) hide();
      timer.current = 0;
    } else if (!open && !timer.current) show();
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const toBuy = s.slots.filter((x) => !x.owned);
  const cost = toBuy.reduce((sum, x) => sum + (x.price ?? 0), 0);
  const top = [...s.slots].sort((x, y) => y.rating - x.rating);
  const face = (x: (typeof s.slots)[number]): FutCardData => ({ name: x.name, rating: x.rating, position: x.pos, defId: x.def_id });
  const rows = pitchRows(s.slots as unknown as SlotView[]) as unknown as (typeof s.slots)[];
  return (
    <li
      className={`sq-saved-card panel ring m ${open ? "open" : ""}`}
      tabIndex={0}
      aria-label={`${s.event} · ${s.formation}`}
      onMouseMove={onMove}
      onMouseLeave={() => (hide(), (timer.current = 0))}
      onFocus={(e) => e.currentTarget.matches(":focus-visible") && setOpen(true)}
      onBlur={hide}
      onClick={hide}
      onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), hide())}
    >
      <header>
        <b className="sq-saved-f">{s.formation}</b>
        <span className="chip line ring" title={t("squads.savedMeta", { formation: s.formation, met: s.met, reqs: s.reqs, when: formatAge(s.saved_at) })}>
          <b className="num">{s.met}</b>/{s.reqs}
        </span>
        <button
          className="sq-saved-x"
          onClick={(e) => {
            e.stopPropagation();
            removeSquad(s.id);
          }}
          aria-label={t("squads.savedRemove")}
          title={t("squads.savedRemove")}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="square" /></svg>
        </button>
      </header>
      <span className="sq-saved-ev ellip" title={s.event}>{s.event}</span>
      <span className="sq-saved-faces">
        {top.slice(0, 4).map((x, i) => (
          <FaceChip key={i} card={face(x)} s={34} pos={x.pos} />
        ))}
        {s.slots.length > 4 && <span className="faint t-13">+{s.slots.length - 4}</span>}
      </span>
      <span className="sq-saved-foot faint t-12 ellip">
        {formatAge(s.saved_at)}
        {toBuy.length > 0 && <> · {t("squads.savedToBuy", { count: toBuy.length, coins: num(cost) })}</>}
      </span>
      {open && (
        <div className="sq-saved-pop panel ring tier-dense" role="tooltip">
          {rows.map((row, k) => (
            <span key={k} className="sq-saved-line">
              {row.map((x, i) => (
                <FaceChip key={i} card={face(x)} s={40} pos={x.pos} />
              ))}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

export function SavedSquads({ limit }: { limit?: number }) {
  const list = useSavedSquads();
  const shown = limit ? list.slice(0, limit) : list;
  return (
    <section className="sq-saved" aria-label={t("squads.savedTitle")}>
      <h3>{t("squads.savedTitle")}</h3>
      {shown.length === 0 ? (
        <p className="sq-muted">{t("squads.savedEmpty")}</p>
      ) : (
        <ul className="sq-saved-grid">
          {shown.map((s) => (
            <SavedCard key={s.id} s={s} />
          ))}
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

/** A remembered on/off for this viewer (a folded section): local only, a default without storage. */
function useFlag(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s == null ? initial : s === "1";
    } catch {
      return initial;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {}
  };
  return [v, set];
}

/** The latest look at the game's Squad screen (live squad check), shared by every view of the window. */
let lastSeen: SquadSeen | null = null;
const seenListeners = new Set<(s: SquadSeen) => void>();
let seenStarted = false;
function useSquadSeen(): SquadSeen | null {
  const [seen, setSeen] = useState(lastSeen);
  useEffect(() => {
    if (!seenStarted) {
      seenStarted = true;
      const push = (x: SquadSeen) => {
        lastSeen = x;
        seenListeners.forEach((l) => l(x));
      };
      void events.onSquadSeen(push);
      // dev only: try the check without the game – window.dispatchEvent(new CustomEvent("fct:dev-squad-seen", { detail }))
      if (import.meta.env.DEV) window.addEventListener("fct:dev-squad-seen", (e) => push((e as CustomEvent<SquadSeen>).detail));
    }
    seenListeners.add(setSeen);
    return () => void seenListeners.delete(setSeen);
  }, []);
  return seen;
}

/** The plan, rebuilt after every sync and every settings change. */
/** The plan, kept between visits of the tab (user 2026-11-01: "it must not load every time"):
 *  worked out again only when something it depends on changed – a sync, a counted match, a setting
 *  – or after a while (the clock moves end times on). */
let cachedPlan: SquadsView | null = null;
let cachedAt = 0;
let planStale = true;
const PLAN_FRESH_MS = 10 * 60_000;
let watching = false;
function watchPlanInputs() {
  if (watching) return;
  watching = true;
  const stale = () => {
    planStale = true;
  };
  void events.onGalleryUpdated(stale);
  void events.onSquadsChanged(stale);
  void events.onSyncDone(stale);
}

/** EA's team rating (FUT): the XI's total plus every rating above the average, divided by the players, rounded down. */
export const teamRating = (rs: number[]) => {
  if (!rs.length) return 0;
  const total = rs.reduce((a, r) => a + r, 0);
  const avg = total / rs.length;
  return Math.floor((total + rs.reduce((a, r) => a + Math.max(0, r - avg), 0)) / rs.length);
};

const PLAN_EVENT = "fct:squads-plan";
/** The first session's objective count from the last plan built (the overlay slab's "Objectives 22"); null until a
 *  plan exists – it never builds one itself. */
export function usePlanCount(): number | null {
  const [n, setN] = useState<number | null>(cachedPlan?.combos[0]?.counted ?? null);
  useEffect(() => {
    const on = () => setN(cachedPlan?.combos[0]?.counted ?? null);
    window.addEventListener(PLAN_EVENT, on);
    return () => window.removeEventListener(PLAN_EVENT, on);
  }, []);
  return n;
}

export function useSquads(): [SquadsView | null, boolean, (p: SquadPrefs) => void] {
  const [view, setView] = useState<SquadsView | null>(cachedPlan);
  const [busy, setBusy] = useState(cachedPlan == null);
  const load = () => {
    setBusy(true);
    api
      .squadsPlan()
      .then((v) => {
        cachedPlan = v;
        cachedAt = Date.now();
        planStale = false;
        setView(v);
        window.dispatchEvent(new window.Event(PLAN_EVENT));
      })
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    watchPlanInputs();
    if (!cachedPlan || planStale || Date.now() - cachedAt > PLAN_FRESH_MS) load();
    // a sync brings new objectives and club cards – one rebuild when its pages settle, not one per
    // page (the view kept jumping while a sync ran)
    let timer = 0;
    const un = events.onGalleryUpdated(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 5000);
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
    // a sub minute changes no squad: saved, nothing worked out again
    const strip = (x: SquadPrefs | undefined) => JSON.stringify({ ...x, sub_at: undefined });
    const same = view != null && strip(view.prefs) === strip(p);
    setView((v) => {
      const next = v ? { ...v, prefs: p } : v;
      if (next) cachedPlan = next;
      return next;
    });
    api.setSquadPrefs(p).then(same ? undefined : load).catch(() => {});
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

/** Position groups for the club search's filter. */
const POS_GROUPS = { GK: ["GK"], CB: ["CB"], "LB/RB": ["LB", "RB", "LWB", "RWB"], "CDM/CM": ["CDM", "CM"], CAM: ["CAM"], Wings: ["LM", "RM", "LW", "RW"], ST: ["ST", "CF"] } as const;

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
  // forgiving search: Etoo finds Eto'o, Gross finds Gro\u00df (src/search.ts)
  const words = fold(q).split(" ").filter(Boolean);
  // filters (user 2026-11-03: "no filters, nothing"): position group, min rating, owned / to get
  const [group, setGroup] = useState<keyof typeof POS_GROUPS | "all">("all");
  const [minR, setMinR] = useState(0);
  const [owner, setOwner] = useState<"all" | "owned" | "toget">("all");
  const keep = (c: ClubEntry) => (group === "all" || c.positions.some((p) => (POS_GROUPS[group] as readonly string[]).includes(p))) && c.rating >= minR;
  const list = owner === "toget" ? [] : view.club.filter((c) => c.owned && keep(c) && words.every((w) => fold(c.name).includes(w) || c.positions.some((p) => p.toLowerCase() === w) || String(c.rating) === w)).sort((a, b) => b.rating - a.rating).slice(0, 80);
  const catalog = owner === "owned" ? [] : (found ?? []).filter(keep);
  const row = (c: ClubEntry) => (
    <li key={`${c.owned}-${c.key}`}>
      <button className={picked(c) ? "on" : ""} aria-pressed={picked(c)} onClick={() => toggle(c)}>
        <b className="sq-club-rating">{c.rating}</b>
        <Flag nation={c.nation} name={c.nation_name} size={16} />
        <span className="sq-club-name">{c.name}</span>
        <small className="sq-club-pos" title={c.positions.join(" · ")}>{c.positions.join(" · ")}</small>
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
          <div className="sq-club-filters" role="group" aria-label={t("squads.find.filters")}>
            {(["all", ...Object.keys(POS_GROUPS)] as (keyof typeof POS_GROUPS | "all")[]).map((g) => (
              <button key={g} className={`cat-tab ${group === g ? "active" : ""}`} aria-pressed={group === g} onClick={() => setGroup(g)}>
                {g === "all" ? t("squads.find.allPos") : g}
              </button>
            ))}
            <label className="sq-club-min">
              <span>{t("squads.find.min", { value: minR || "–" })}</span>
              <input type="range" min={0} max={95} step={1} value={minR} onChange={(e) => setMinR(Number(e.target.value))} aria-label={t("squads.find.minLabel")} />
            </label>
            {(["all", "owned", "toget"] as const).map((o) => (
              <button key={o} className={`cat-tab ${owner === o ? "active" : ""}`} aria-pressed={owner === o} onClick={() => setOwner(o)}>
                {t(`squads.find.${o}` as MessageKey)}
              </button>
            ))}
          </div>
          {owner !== "toget" && (
            <ul className="sq-club-list">
              {list.map(row)}
              {list.length === 0 && <li className="sq-muted">{t("squads.must.noMatch")}</li>}
            </ul>
          )}
          {owner !== "owned" && q.trim().length < 3 && <small className="sq-muted">{t("squads.find.catalogHint")}</small>}
          {owner !== "owned" && q.trim().length >= 3 && (
            <>
              <small className="sq-club-head">{t("squads.must.catalog")}</small>
              {found == null ? (
                <p className="ml-loading sq-muted">{t("squads.must.searching")}</p>
              ) : (
                <ul className="sq-club-list">
                  {catalog.map(row)}
                  {catalog.length === 0 && <li className="sq-muted">{t("squads.must.noCards")}</li>}
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
  // the older single pick counts as one of the ranked ones
  const ranked = Array.from(new Set([...(prefs.formations ?? []), ...(prefs.formation ? [prefs.formation] : [])]));
  const setRanked = (list: string[]) => onChange({ ...prefs, formation: null, formations: list });
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= ranked.length) return;
    const next = [...ranked];
    [next[i], next[j]] = [next[j], next[i]];
    setRanked(next);
  };
  const rest = formations.filter((f) => !ranked.includes(f));
  return (
    <div className="sq-settings panel ring tier-dense" role="group" aria-label={t("squads.settings")}>
      <div className="sq-set-col">
        <Choice label={t("squads.goal.label")} options={GOALS.map(([v, k]) => [v, t(k)])} value={prefs.goal ?? "progress"} onPick={(goal) => onChange({ ...prefs, goal })} />
        <Choice<string>
          label={t("squads.chemPreset.label")}
          options={[
            ["balanced", t("squads.chemMode.balanced")],
            ["30", t("squads.chemMode.30")],
            ["33", t("squads.chemMode.33")],
          ]}
          value={prefs.chem_mode ?? "balanced"}
          onPick={(chem_mode) => onChange({ ...prefs, chem_mode })}
        />
        <small className="sq-muted sq-setting-hint">{t(`squads.chemMode.${prefs.chem_mode === "30" || prefs.chem_mode === "33" ? prefs.chem_mode : "balanced"}Hint` as MessageKey)}</small>
        <Choice label={t("squads.buys.label")} options={BUYS.map(([v, k]) => [v, t(k)])} value={prefs.max_buys === undefined ? 3 : prefs.max_buys} onPick={(max_buys) => onChange({ ...prefs, max_buys })} />
        <div className="sq-set-switches">
          {!IS_WEB && (
            <label className="sq-set-switch">
              <Switch on={prefs.track !== false} onChange={(track) => onChange({ ...prefs, track })} label={t("squads.track")} />
              <span>{t("squads.track")}</span>
            </label>
          )}
        </div>
      </div>
      {/* formations: a ranked list the user orders – the first wins unless another is clearly better (squads.rs) */}
      <div className="sq-set-col sq-formations" role="group" aria-label={t("squads.formations.label")}>
        <span className="sq-choice-label">{t("squads.formations.label")}</span>
        <small className="sq-muted">{ranked.length ? t("v2.sq.formRanked") : t("v2.sq.formAny")}</small>
        <ol className="list sq-form-list">
          {ranked.map((f, i) => (
            <li key={f} className="lrow">
              <span className="num sq-form-n">{i + 1}</span>
              <b className="sq-form-name">{f}</b>
              <span className="sq-form-acts">
                <button className="btn btn-quiet btn-s" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t("v2.sq.formUp", { f })} title={t("v2.sq.formUp", { f })}>
                  ↑
                </button>
                <button className="btn btn-quiet btn-s" disabled={i === ranked.length - 1} onClick={() => move(i, 1)} aria-label={t("v2.sq.formDown", { f })} title={t("v2.sq.formDown", { f })}>
                  ↓
                </button>
                <button className="btn btn-quiet btn-s" onClick={() => setRanked(ranked.filter((x) => x !== f))} aria-label={t("v2.sq.formRemove", { f })} title={t("v2.sq.formRemove", { f })}>
                  ×
                </button>
              </span>
            </li>
          ))}
        </ol>
        <span className="sq-form-add">
          <select className="sq-select" value="" aria-label={t("v2.sq.formAdd")} onChange={(e) => e.target.value && setRanked([...ranked, e.target.value])}>
            <option value="">{t("v2.sq.formAdd")}</option>
            {rest.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          {ranked.length > 0 && (
            <button className="btn btn-quiet btn-s" onClick={() => setRanked([])}>
              {t("squads.formations.all")}
            </button>
          )}
        </span>
      </div>
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
  // one compact line per unmet requirement; where to get it opens on click (user 2026-11-05: no wall of text)
  const [open, setOpen] = useState(false);
  // Include (user 2026-11-05): the option plays – a club card as "has to include", a card to get as one to buy
  const edit = useContext(EditCtx);
  const clubKey = (o: GetOption) => edit?.club.find((c) => c.owned && c.def_id === o.def_id)?.key ?? null;
  const included = (o: GetOption) => {
    const k = clubKey(o);
    return k != null ? (edit?.prefs.must ?? []).includes(k) : (edit?.prefs.must_cards ?? []).includes(o.def_id);
  };
  const include = (o: GetOption) => {
    if (!edit) return;
    const k = clubKey(o);
    const p = edit.prefs;
    if (k != null) edit.onPrefs({ ...p, must: included(o) ? p.must.filter((x) => x !== k) : [...p.must, k], exclude: (p.exclude ?? []).filter((x) => x !== k) });
    else edit.onPrefs({ ...p, must_cards: included(o) ? (p.must_cards ?? []).filter((x) => x !== o.def_id) : [...(p.must_cards ?? []), o.def_id] });
  };
  if (r.met) return null;
  return (
    <div className={`sq-gap ${open ? "open" : ""}`}>
      <button data-f className="sq-gap-line" aria-expanded={open} onClick={() => setOpen(!open)} title={gapLine(r)}>
        <i className="dot warn" aria-hidden="true" />
        <span className="ellip">{reqLabel(r)}</span>
        <span className="faint t-12 nowrap">{r.options.length ? t("v2.sq.options", { count: r.options.length }) : t("v2.sq.noneClub")}</span>
        <span className="sq-gap-caret" aria-hidden="true" />
      </button>
      {open && <small>{gapLine(r)}</small>}
      {!open ? null : r.options.length === 0 ? (
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
              {edit && !edit.prefs.locked && o.def_id > 0 && (
                <button type="button" className={`btn btn-s ${included(o) ? "btn-secondary ring is-on" : "btn-secondary ring"} sq-include`} aria-pressed={included(o)} onClick={() => include(o)}>
                  {included(o) ? t("v2.sq.included") : t("v2.sq.include")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && r.unpriced > 0 && <p className="sq-muted">{t("squads.unpriced", { count: r.unpriced })}</p>}
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

function CardDetail({ s, e, onClose, onChange, onLeaveOut }: { s: SlotView; e: SquadSource; onClose: () => void; onChange?: () => void; onLeaveOut?: () => void }) {
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
      {(onChange || onLeaveOut) && (
        <div className="sq-detail-actions">
          {onChange && (
            <button className="cat-tab active" onClick={onChange}>
              {t("squads.change.one")}
            </button>
          )}
          {onLeaveOut && (
            <button className="cat-tab" onClick={onLeaveOut}>
              {t("squads.change.leaveOut", { name: s.name })}
            </button>
          )}
        </div>
      )}
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

/** "Change players" (user 2026-11-04): the cards picked are swapped out of their slots – FC-Tracker re-solves, each
 *  is replaced or moves, the rest adapts. Never a "has to include" (squads.rs SwapOut). */
export const swapOut = (p: SquadPrefs, out: SlotView[]): SquadPrefs => {
  const have = p.swaps ?? [];
  const add = out.map((s) => ({ key: slotKey(s), pos: s.pos })).filter((w) => !have.some((x) => x.key === w.key && x.pos === w.pos));
  return { ...p, swaps: [...have, ...add], must: p.must.filter((k) => !out.some((s) => slotKey(s) === k)) };
};
/** Swap to exactly this player (user 2026-11-05): `c` plays at `s`'s position, `s` leaves it, the rest re-solves. */
export const swapTo = (p: SquadPrefs, s: SlotView, c: number): SquadPrefs => {
  const out = swapOut(p, [s]);
  return {
    ...out,
    // one pick per card: an older pick of either card goes; the new one is never left out or swapped from there
    pins: [...(p.pins ?? []).filter((w) => w.key !== c && w.key !== slotKey(s)), { key: c, pos: s.pos }],
    swaps: (out.swaps ?? []).filter((w) => !(w.key === c && w.pos === s.pos)),
    exclude: (p.exclude ?? []).filter((k) => k !== c),
  };
};
/** Leave cards out of every squad (the old "Change" without a pick). */
const leaveOut = (p: SquadPrefs, out: SlotView[]): SquadPrefs => ({
  ...p,
  exclude: Array.from(new Set([...(p.exclude ?? []), ...out.map(slotKey)])),
  must: p.must.filter((k) => !out.some((s) => slotKey(s) === k)),
});

/** The player opened on the pitch: shown in the middle column (mockup 06), where it can be swapped. */
const SwapCtx = createContext<{ opened: SlotView | null; setOpened: (s: SlotView | null) => void }>({ opened: null, setOpened: () => {} });

/** The opened player, in place of the objectives (mockup 06 "Change Lavelle · CAM"): who he is in this squad, the
 *  club's strongest alternatives by meta, and Swap (FC-Tracker re-solves) or Leave out. */
function SwapPanel({ s, e, onClose }: { s: SlotView; e: SquadSource; onClose: () => void }) {
  const edit = useContext(EditCtx);
  const canEdit = !!edit && !edit.prefs.locked && s.owned;
  const inXi = new Set(e.squad?.slots.map(slotKey) ?? []);
  const out = new Set(edit?.prefs.exclude ?? []);
  const xiCards = new Set((e.squad?.slots ?? []).map((x) => `${x.name}|${x.rating}`));
  const alts = (edit?.club ?? [])
    // the XI by key – and by name + rating for plans that predate slot keys
    .filter((c) => c.owned && !inXi.has(c.key) && !xiCards.has(`${c.name}|${c.rating}`) && !out.has(c.key) && c.positions.includes(s.pos))
    .sort((a, b) => (b.meta?.[s.pos] ?? b.rating) - (a.meta?.[s.pos] ?? a.rating))
    .slice(0, 8);
  const card = (c: ClubEntry): FutCardData => ({ name: c.name, rating: c.rating, position: s.pos, rareflag: c.rareflag ?? null, defId: c.def_id ?? null, actionGuid: c.art ?? null });
  // the player picked in the list (user 2026-11-05: "I must be able to change to exactly the player I want");
  // none = Swap lets FC-Tracker choose
  const [pick, setPick] = useState<number | null>(null);
  const picked = alts.find((c) => c.key === pick) ?? null;
  const swap = () => (edit!.onPrefs(picked ? swapTo(edit!.prefs, s, picked.key) : swapOut(edit!.prefs, [s])), onClose());
  return (
    <section className="panel ring tier-dense sq-colp sq-swap" aria-label={t("squads.change.title", { name: s.name, pos: s.pos })}>
      <header>
        <div>
          <span className="h4 ellip" title={t("squads.change.title", { name: s.name, pos: s.pos })}>{t("squads.change.title", { name: s.name, pos: s.pos })}</span>
          <span className="sq-muted">{t("v2.sq.candidates")}</span>
        </div>
        <button className="btn btn-quiet btn-s" onClick={onClose}>
          <Keycap ps="○" xb="B" kb="Esc" />
          {t("v2.sq.done")}
        </button>
      </header>
      <div className="sq-colp-body">
        <div className="list pick-list">
          <button type="button" className={`lrow ${picked ? "" : "is-sel"}`} data-f aria-pressed={!picked} onClick={() => setPick(null)} title={t("v2.sq.autoHint")}>
            <FaceChip card={slotCard(s)} s={44} pos={s.pos} />
            <span className="col" style={{ gap: 2 }}>
              <b className="strong">{s.name}</b>
              <span className="faint t-13">{t("v2.sq.inXi", { count: s.counts_for.length })}</span>
            </span>
            <span className="num t-20">{s.strength.toFixed(1)}</span>
          </button>
          {alts.map((c) => (
            <button type="button" key={c.key} className={`lrow ${pick === c.key ? "is-sel" : ""}`} data-f aria-pressed={pick === c.key} disabled={!canEdit} onClick={() => setPick(c.key)} onDoubleClick={() => canEdit && (edit!.onPrefs(swapTo(edit!.prefs, s, c.key)), onClose())}>
              <FaceChip card={card(c)} s={44} pos={s.pos} />
              <span className="col" style={{ gap: 2 }}>
                <b className="strong">{c.name}</b>
                <span className="faint t-13">{c.positions.join(" · ")}</span>
              </span>
              <span className="num t-20">{c.meta?.[s.pos] != null ? c.meta[s.pos].toFixed(1) : c.rating}</span>
            </button>
          ))}
          {alts.length === 0 && <p className="sq-muted">{t("squads.change.none", { pos: s.pos })}</p>}
        </div>
        {/* what this card is in the squad: rating there, bio, chemistry, what it counts for */}
        <CardDetail s={s} e={e} onClose={onClose} />
      </div>
      {canEdit && (
        <footer className="sq-swap-foot">
          <button className="btn btn-secondary ring btn-s" onClick={() => (edit!.onPrefs(leaveOut(edit!.prefs, [s])), onClose())}>
            {t("v2.sq.leaveOut")}
          </button>
          <button className="btn btn-primary btn-s" onClick={swap} title={picked ? undefined : t("v2.sq.autoHint")}>
            <Keycap ps="✕" xb="A" kb="Enter" />
            {picked ? t("v2.sq.swapTo", { name: picked.name }) : t("v2.sq.swap")}
          </button>
        </footer>
      )}
    </section>
  );
}

/** The XI on a pitch, attack at the top; a card opens its details. */
/** A card on the bench: an evolution player or one for objectives a sub does. */
interface BenchCard {
  key: number;
  name: string;
  pos: string;
  rating: number;
  nation: number;
  nation_name: string | null;
  /** The evo, or the objectives he counts for. */
  why: string;
}

/** The session's bench: evo players not in the XI first, then the bench cards. */
export function benchOf(s: SessionPlan): BenchCard[] {
  const evos = (s.evos ?? []).filter((x) => !x.in_xi).map((x) => ({ key: x.key, name: x.player, pos: x.pos ?? "", rating: x.rating ?? 0, nation: x.nation ?? 0, nation_name: x.nation_name ?? null, why: x.name }));
  const picks = (s.bench ?? []).map((b) => ({ key: b.key, name: b.name, pos: b.pos, rating: b.rating, nation: b.nation, nation_name: b.nation_name, why: b.objectives.slice(0, 2).join(", ") }));
  return [...evos, ...picks];
}

/** How much one pitch line overlaps the next, as a share of a card's height (FUT's formation view). */
const OVERLAP = 0.16;
/** Two lines whose cards never meet sideways interleave this far (a share of a card). */
const INTERLEAVE = 0.5;

export function Pitch({ e, compact = false, bench = [] }: { e: SquadSource; compact?: boolean; bench?: BenchCard[] }) {
  const subs = useContext(SubCtx);
  const minutes = bench.map((b) => subs.minute(b.key));
  const same = minutes.every((m) => m === minutes[0]);
  const swapCtx = useContext(SwapCtx);
  const open = swapCtx.opened ? slotKey(swapCtx.opened) : null;
  const setOpen = (s: SlotView | null) => swapCtx.setOpened(s);
  const edit = useContext(EditCtx);
  const pitchRef = useRef<HTMLDivElement | null>(null);
  const [cardW, setCardW] = useState(96);
  const lines = e.squad ? pitchRows(e.squad.slots).filter((r) => r.length) : [];
  const widest = Math.max(1, ...lines.map((r) => r.length));
  useEffect(() => {
    const el = pitchRef.current;
    if (!el || compact) return;
    const lastW = { current: 0 };
    const settle = { current: 0 };
    const fit = () => {
      // the largest card at which every line fits (user 2026-11-05: no empty bands): a card is 1.389 × its width
      // + 14 px for the foot tag, lines overlap by OVERLAP of a card like FUT's pitch; the pitch's padding holds the
      // facts bands (top: legend · formation + chemistry, bottom: rating · meta · changes | Change players)
      const cs = getComputedStyle(el);
      const W = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const n = Math.max(1, lines.length);
      const byW = W / widest - 14;
      // lines that share no horizontal room interleave (FUT staggers its lines): the overlap between two lines is
      // OVERLAP of a card when any of their cards would touch, else up to INTERLEAVE – measured on the cards' centres
      const k = el.clientWidth / (el.getBoundingClientRect().width || el.clientWidth);
      const left = el.getBoundingClientRect().left;
      const lineEls = Array.from(el.querySelectorAll<HTMLElement>(":scope > .sq-line"));
      const centres = lineEls.map((l) => Array.from(l.children).map((c) => { const r = c.getBoundingClientRect(); return (r.left + r.width / 2 - left) * k; }));
      const touch = (i: number, w: number) => centres[i].some((x) => centres[i + 1].some((y) => Math.abs(x - y) < w + 10));
      const shares = (w: number) => centres.slice(1).map((_, i) => (touch(i, w) ? OVERLAP : INTERLEAVE));
      const size = (pt: number, pb: number) => {
        let w = byW;
        for (let i = 0; i < 3; i++) {
          const cardH = (el.clientHeight - pt - pb) / (n - shares(w).reduce((a, b) => a + b, 0));
          w = Math.round(Math.max(44, Math.min(150, (cardH - 14) / 1.389, byW)));
        }
        return w;
      };
      // a band (facts / legend / Change players) sits in the corners beside the first or last line when they are
      // free at that card size – the outer card of a line of k leaves (W / (k + 1) − w / 2)
      const free = (k: number, w: number) => W / (k + 1) - w / 2 - 8;
      const bandW = (sel: string) => Math.max(0, ...Array.from(el.querySelectorAll<HTMLElement>(sel)).map((x) => x.offsetWidth));
      const top = Math.max(bandW(".sq-pitch-band.top > :first-child"), bandW(".sq-pitch-band.top > .sq-pitch-facts"));
      const foot = Math.max(bandW(".sq-pitch-band.foot > :first-child"), bandW(".sq-pitch-band.foot > .sq-foot-acts"));
      const first = lines[0]?.length ?? 1, last = lines[lines.length - 1]?.length ?? 1;
      let pt = 52, pb = 60;
      for (let i = 0; i < 2; i++) {
        const w = size(pt, pb);
        pt = top && top > free(first, w) ? 52 : 14;
        pb = foot && foot > free(last, w) ? 60 : 14;
      }
      const w = size(pt, pb);
      el.style.paddingTop = `${pt}px`;
      el.style.paddingBottom = `${pb}px`;
      setCardW(w);
      // the cards' centres move a little with their size: measure once more after they re-render
      if (w !== lastW.current && settle.current++ < 3) requestAnimationFrame(fit);
      lastW.current = w;
      const H = w * 1.389 + 14;
      shares(w).forEach((sh, i) => lineEls[i + 1]?.style.setProperty("margin-top", `${-Math.round(H * sh)}px`));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [lines.length, widest, compact]);
  // "Change players": several cards picked, then swapped (FC-Tracker re-solves) or left out
  const [multi, setMulti] = useState(false);
  const [ticked, setTicked] = useState<number[]>([]);
  const sq = e.squad;
  useEffect(() => {
    setMulti(false);
    setTicked([]);
  }, [e.id]);
  // a swap / leave-out re-solves the squad: the pitch says so until the new plan arrives (every wait visible)
  const [rebuilding, setRebuilding] = useState(false);
  useEffect(() => setRebuilding(false), [sq]);
  useEffect(() => {
    if (!rebuilding) return;
    const id = window.setTimeout(() => setRebuilding(false), 20_000);
    return () => window.clearTimeout(id);
  }, [rebuilding]);
  if (!sq) return <p className="sq-muted">{t("squads.noSquad")}</p>;
  const canEdit = !!edit && !edit.prefs.locked;
  const finish = (p: SquadPrefs) => {
    setRebuilding(true);
    edit?.onPrefs(p);
    setMulti(false);
    setTicked([]);
    setOpen(null);
  };
  const ticks = sq.slots.filter((s) => ticked.includes(slotKey(s)));
  const clubOf = (k: number) => edit?.club.find((c) => c.key === k);
  return (
    <div className={`sq-squad ${compact ? "compact" : ""}`}>
      {sq.must_missing.length > 0 && <p className="sq-muted warn">{t("squads.must.missing", { names: sq.must_missing.join(", ") })}</p>}
      <div className={`sq-pitch ${multi ? "changing" : ""} ${rebuilding ? "rebuilding" : ""}`} ref={pitchRef} aria-busy={rebuilding}>
        {/* Change players and its bar live inside the pitch, along its foot – never over a card */}
        {!compact && (
          <>
            <div className="sq-pitch-band top" aria-hidden={multi || undefined}>
              {!multi && (
                <span className="sq-legend" title={t("v2.sq.legendRule")}>
                  <span>
                    <Chem n={3} /> {t("v2.sq.legendChem")}
                  </span>
                  <span>
                    <b className="cnt">#</b> {t("v2.sq.legendCounts")}
                  </span>
                </span>
              )}
              <span className="sq-pitch-facts">
                <span className="chip line ring">{sq.formation}</span>
                <span className={`chip line ring ${sq.chem >= sq.chem_target ? "" : "warn"}`}>{t("squads.chem", { chem: sq.chem, target: 33 })}</span>
              </span>
            </div>
            {!multi && (
              <div className="sq-pitch-band foot">
                <span className="sq-pitch-facts">
                  <span className="chip line ring" title={t("v2.sq.ratingHint")}>
                    {t("v2.sq.rating")} <b className="num">{teamRating(sq.slots.map((x) => x.rating))}</b>
                  </span>
                  <span className="chip line ring" title={t("squads.detail.rating")}>
                    {t("v2.sq.meta")} <b className="num">{sq.strength.toFixed(1)}</b>
                  </span>
                  {sq.changes != null && <span className="chip line ring">{t("squads.changes", { count: sq.changes })}</span>}
                  {sq.buys > 0 && <span className="chip accent-soft ring">{sq.cost > 0 ? t("squads.buysCost", { count: sq.buys, coins: num(sq.cost) }) : t("squads.buysCount", { count: sq.buys })}</span>}
                </span>
                {canEdit && (
                  <span className="row sq-foot-acts" style={{ gap: 8 }}>
                    {/* Reroll (user 2026-11-05): a fresh solve, not a pile of swaps – the swaps are reset and the next-best
                        formation's squad comes in (squads.rs reroll) */}
                    <button data-f className="btn btn-s btn-secondary ring sq-reroll-btn" onClick={() => edit!.onPrefs({ ...edit!.prefs, swaps: [], reroll: (edit!.prefs.reroll ?? 0) + 1 })} title={t("v2.sq.rerollHint")}>
                      {t("v2.sq.reroll")}
                    </button>
                    <button data-f className="btn btn-s btn-secondary ring sq-change-btn" aria-pressed={false} onClick={() => (setMulti(true), setTicked([]), setOpen(null))}>
                      <Keycap ps="□" xb="X" kb="I" />
                      {t("squads.change.players")}
                    </button>
                  </span>
                )}
              </div>
            )}
          </>
        )}
        {compact && (
        <div className="sq-squad-head">
          <b>{sq.formation}</b>
          <span className={sq.chem >= sq.chem_target ? "ok" : "short"}>{t("squads.chem", { chem: sq.chem, target: 33 })}</span>
          <span>
            <span className="sq-gem" aria-hidden="true" />
            {t("squads.avg", { value: sq.strength.toFixed(1) })}
          </span>
          {sq.changes != null && !compact && <span>{t("squads.changes", { count: sq.changes })}</span>}
          {sq.buys > 0 && <span className="short">{sq.cost > 0 ? t("squads.buysCost", { count: sq.buys, coins: num(sq.cost) }) : t("squads.buysCount", { count: sq.buys })}</span>}
          {canEdit && (
            !multi && (
              <button data-f className="btn btn-s btn-secondary ring sq-change-btn" aria-pressed={false} onClick={() => (setMulti(true), setTicked([]), setOpen(null))}>
                <Keycap ps="□" xb="X" kb="I" />
                {t("squads.change.players")}
              </button>
            )
          )}
        </div>
        )}
        {multi && (
          <div className="sq-multibar" role="toolbar" aria-label={t("squads.change.players")}>
            <span className="sq-multibar-text">
              <b>{ticks.length ? t("squads.change.ticked", { count: ticks.length }) : t("squads.change.tickHint")}</b>
              <small>{t("v2.sq.swapHint")}</small>
            </span>
            <button className="btn btn-quiet btn-s" onClick={() => (setMulti(false), setTicked([]))}>
              <Keycap ps="○" xb="B" kb="Esc" />
              {t("squads.change.cancel")}
            </button>
            <button className="btn btn-secondary ring btn-s" disabled={!ticks.length} onClick={() => finish(leaveOut(edit!.prefs, ticks))}>
              {t("squads.change.leaveOutN", { count: ticks.length })}
            </button>
            <button className={`btn btn-s ${ticks.length ? "btn-primary" : "btn-disabled"}`} disabled={!ticks.length} onClick={() => finish(swapOut(edit!.prefs, ticks))}>
              <Keycap ps="✕" xb="A" kb="Enter" />
              {t("v2.sq.swapN", { count: ticks.length })}
            </button>
          </div>
        )}
        {rebuilding && (
          <div className="sq-rebuild" role="status">
            <span className="sq-rebuild-mark">FC-Tracker</span>
            <span className="ml-loading">{t("v2.sq.rebuilding")}</span>
          </div>
        )}
        {pitchRows(sq.slots).map((row, k) => (
          <div className="sq-line" key={k}>
            {row.map((s) => (
              <button
                key={`${s.pos}-${s.def_id}`}
                data-f
                className={`sq-card ${s.counts_for.length ? "counts" : ""} ${s.must ? "must" : ""} ${!s.owned ? "buy" : ""} ${s.out_of_position ? "oop" : ""} ${open === slotKey(s) ? "open" : ""} ${multi && ticked.includes(slotKey(s)) ? "ticked" : ""}`}
                title={s.counts_for.map((i) => reqLabel(e.reqs[i])).join(" · ")}
                aria-expanded={multi ? undefined : open === slotKey(s)}
                aria-pressed={multi ? ticked.includes(slotKey(s)) : undefined}
                onClick={() =>
                  multi
                    ? setTicked((cur) => (cur.includes(slotKey(s)) ? cur.filter((k) => k !== slotKey(s)) : [...cur, slotKey(s)]))
                    : setOpen(open === slotKey(s) ? null : s)
                }
              >
                {multi && <span className="sq-tick" aria-hidden="true">{ticked.includes(slotKey(s)) ? "✓" : ""}</span>}
                <FutCard card={slotCard(s)} size={compact || cardW < 90 ? "mini" : "small"} w={compact ? 64 : cardW} pos={s.pos} toGet={!s.owned} />
                {/* FUT: chemistry and what the card does sit on the card's foot */}
                <span className="slot-tag" title={t("squads.detail.rating") + " " + s.strength.toFixed(1)}>
                  <Chem n={s.chem} />
                  {s.counts_for.length > 0 && (
                    <>
                      <i className="vr" />
                      <span className="cnt">{s.counts_for.length}</span>
                    </>
                  )}
                  {s.evo && <Tag title={s.evo}>{t("squads.evo.tag")}</Tag>}
                  {s.loan && <Tag>{t("squads.loan")}</Tag>}
                  {s.out_of_position && <Tag tone="warn">{t("squads.slot.oop")}</Tag>}
                  {!s.owned && <Tag tone="accent">{slotKind(s)}</Tag>}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {bench.length > 0 && (
        <div className="sq-bench-row" aria-label={t("squads.bench.label")}>
          <span className="sq-bench-label">{same ? t("squads.bench.title", { minute: minutes[0] }) : t("squads.bench.label")}</span>
          <div className="sq-line">
            {bench.map((b, i) =>
              compact ? (
                <div key={i} className="sq-card bench" title={b.why}>
                  <span className="sq-card-top">
                    <b>{b.rating || ""}</b>
                    {b.nation > 0 && <Flag nation={b.nation} name={b.nation_name} size={14} />}
                    <span>{b.pos}</span>
                  </span>
                  <span className="sq-name">{b.name}</span>
                  <SubMinute k={b.key} />
                </div>
              ) : (
                <div key={i} className="sq-bench-chip" title={b.why}>
                  <FaceChip card={{ name: b.name, rating: b.rating || null, position: b.pos, defId: clubOf(b.key)?.def_id ?? null, rareflag: clubOf(b.key)?.rareflag ?? null }} s={40} pos={b.pos} />
                  <span className="col">
                    <b className="strong ellip">{b.name}</b>
                    <small className="muted ellip">{b.why}</small>
                  </span>
                  <SubMinute k={b.key} />
                </div>
              ),
            )}
          </div>
        </div>
      )}
      {!compact && <ManagerLine sq={sq} />}
      <LeftOut />
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
        {e.squad && <LockButton e={e} event={e.id} />}
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
  // left / right (D-pad, arrows) step through where to play – the controller's way to these tabs
  const placesRef = useRef({ view, prefs, onPrefs });
  placesRef.current = { view, prefs, onPrefs };
  useEffect(() => {
    const on = (e: Event) => {
      const { view, prefs, onPrefs } = placesRef.current;
      const ps = view.primary != null ? view.places : [];
      if (ps.length < 2) return;
      const cur = Math.max(0, ps.findIndex((p) => sameMode(p.place, prefs.place ?? view.combos[0]?.place)));
      const next = ps[(cur + (e as CustomEvent<number>).detail + ps.length) % ps.length];
      onPrefs({ ...prefs, place: next.place });
    };
    window.addEventListener("fct:squads-place", on);
    return () => window.removeEventListener("fct:squads-place", on);
  }, []);
  return (
    <div className="sq-play compact">
      <label className="sq-choice sq-play-pick" title={t("squads.play.followsGame")}>
        <span className="sq-choice-label">{t("squads.play.short")}</span>
        <EventSelect list={list} value={view.primary ?? prefs.primary ?? null} auto={t("squads.play.autoGame")} label={t("squads.play.title")} onPick={(primary) => onPrefs({ ...prefs, primary, place: null })} />
      </label>
      {view.primary != null && view.places.length > 1 && (
        <div className="sq-choice" role="radiogroup" aria-label={t("squads.play.where")}>
          <span className="sq-choice-label">
            {t("squads.play.where")} <PadHint ids={["left", "right"]} keys="← →" />
          </span>
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
export function SessionList({ s, compact = false, elsewhere, texts = false }: { s: SessionPlan; compact?: boolean; elsewhere?: Map<string, SessionPlan>; texts?: boolean }) {
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
          {!compact && texts && o.name && <p>{o.text}</p>}
          {other ? (
            <small className="sq-req">{t("squads.play.elsewhere", { id: other.id, count: other.quick ?? 1 })}</small>
          ) : o.ask ? (
            <small className="sq-req warn">{t("squads.ask.waiting")}</small>
          ) : o.bench ? (
            <small className="sq-req">{t("squads.slot.bench")}</small>
          ) : r && (texts || compact) ? (
            <small className="sq-req">
              {reqLabel(r)} · {t("squads.have", { have: Math.min(r.have, r.count), count: r.count })}
              {r.players.length > 0 && <> – {r.players.slice(0, 3).join(", ")}</>}
              {o.scorer && <> · {t("squads.play.scorer")}</>}
            </small>
          ) : o.unknown ? (
            <small className="sq-req warn">{t("squads.notRead", { text: o.unknown })}</small>
          ) : texts ? (
            <small className="sq-req">{t("squads.play.anySquad")}</small>
          ) : null}
        </div>
        {!compact && (
          <span className="sq-progress">
            {`${o.progress}/${o.target}`}
            {o.matches != null && o.counts && o.matches >= 0.5 && o.matches < 500 && <small>{t("squads.plan.about", { count: Math.max(1, Math.round(o.matches)) })}</small>}
          </span>
        )}
        {!compact && <Bar value={o.target > 0 ? Math.min(1, o.progress / o.target) : 0} size="thin" tone={o.progress >= o.target ? "done" : "ink"} />}
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



/** The minute bench players are subbed on: Settings → Match reminders (70:00 by default). */
function useSubAt(): number {
  const [at, setAt] = useState(70);
  useEffect(() => {
    api
      .uiPrefs()
      .then((p) => setAt(p.reminders?.sub_at ?? 70))
      .catch(() => {});
  }, []);
  return at;
}

/** Each bench player's sub minute: his own (set on the bench card), else the general one. */
const SubCtx = createContext<{ minute: (key: number) => number; set: (key: number, minute: number | null) => void }>({ minute: () => 70, set: () => {} });
const SUB_STEP = 5;

function SubProvider({ prefs, onPrefs, children }: { prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void; children: React.ReactNode }) {
  const general = useSubAt();
  const own = prefs.sub_at ?? {};
  const value = {
    minute: (key: number) => own[String(key)] ?? general,
    set: (key: number, minute: number | null) => {
      const next = { ...own };
      if (minute == null || minute === general) delete next[String(key)];
      else next[String(key)] = minute;
      onPrefs({ ...prefs, sub_at: next });
    },
  };
  return <SubCtx.Provider value={value}>{children}</SubCtx.Provider>;
}

/** "70:00 − +" on a bench card: this player's sub minute, 5 minutes a step. */
function SubMinute({ k }: { k: number }) {
  const subs = useContext(SubCtx);
  const m = subs.minute(k);
  return (
    <span className="sq-sub-minute">
      <button onClick={() => subs.set(k, Math.max(1, m - SUB_STEP))} aria-label={t("squads.bench.earlier")} title={t("squads.bench.earlier")}>
        −
      </button>
      <b>{m}:00</b>
      <button onClick={() => subs.set(k, Math.min(120, m + SUB_STEP))} aria-label={t("squads.bench.later")} title={t("squads.bench.later")}>
        +
      </button>
    </span>
  );
}



/** The bench (user 2026-11-01): club cards subbed on late for objectives a sub does – only where
 *  they open something the XI doesn't. */
/** Rush (user 2026-11-01): the one player to bring – the whole match is played with him alone. */
function RushCard({ s, compact = false }: { s: SessionPlan; compact?: boolean }) {
  const p = s.rush;
  if (!p) return <p className="sq-muted">{t("squads.rush.none")}</p>;
  // the big card (user 2026-11-05) and what he is in for: the session's objectives he moves on
  const card: FutCardData = { name: p.name, rating: p.rating, position: p.positions?.[0] ?? p.pos, positions: p.positions, rareflag: p.rareflag ?? null, defId: p.def_id || null, nation: p.nation || null, league: p.league || null, club: p.club || null, face: p.face?.length === 6 ? p.face : null, firstOwner: !!p.first_owner, actionGuid: p.art ?? null };
  const why = s.items.filter((x) => x.counts && !x.bonus);
  if (!compact && p.def_id)
    return (
      <div className="sq-squad sq-rush big">
        <span className="sq-bench-label">{t("squads.rush.title")}</span>
        <div className="sq-rush-stage">
          <FutCard card={card} size="full" w={260} toGet={!p.owned} />
          <div className="sq-rush-why">
            <b className="h3">{p.name}</b>
            <span className="dv-small">
              {p.rating} · {p.pos}
              {p.evo ? ` · ${p.evo}` : ""}
            </span>
            {!p.owned && <small className="sq-bench-why">{p.price != null ? t("squads.slot.buy", { price: num(p.price) }) : t("squads.rush.search")}</small>}
            <span className="eyebrow">{t("squads.rush.why", { count: why.length })}</span>
            <ul className="sq-rush-list">
              {why.slice(0, 8).map((x, i) => (
                <li key={i}>
                  <b>{x.name || x.event_title}</b>
                  <span className="faint">{x.progress}/{x.target}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  return (
    <div className={`sq-squad sq-rush ${compact ? "compact" : ""}`}>
      <span className="sq-bench-label">{t("squads.rush.title")}</span>
      <div className="sq-line">
        <div className={`sq-card counts ${p.owned ? "" : "buy"}`}>
          <span className="sq-card-top">
            <b>{p.rating}</b>
            {p.nation > 0 && <Flag nation={p.nation} name={p.nation_name} size={compact ? 14 : 18} />}
            <span>{p.pos}</span>
          </span>
          <span className="sq-name">{p.name}</span>
          {!p.owned && <small className="sq-bench-why">{p.price != null ? t("squads.slot.buy", { price: num(p.price) }) : t("squads.rush.search")}</small>}
          {p.evo && <small className="sq-bench-why">{p.evo}</small>}
        </div>
      </div>
    </div>
  );
}

/** What a session plays with: a live event's rules not read (blunt: no squad), Rush's one player,
 *  else the XI. */
function Lineup({ s, shown, compact = false }: { s: SessionPlan; shown: SquadSource; compact?: boolean }) {
  if (s.rules_unread) return <p className="sq-unread">{t("squads.rules.unread", { event: s.place_name })}</p>;
  if (s.rush_format) return <RushCard s={s} compact={compact} />;
  return <Pitch e={shown} compact={compact} bench={benchOf(s)} />;
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
  // the session shown is the side panel's too (T24): a pick in either window shows in the other
  const [picked, setPicked] = useSessionPick(view);
  const [opened, setOpened] = useState<SlotView | null>(null);
  // one view (user 2026-11-04): the session fills the window to its bottom edge; pitch and columns size inside it
  const artRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const art = artRef.current;
    const wrap = art?.closest<HTMLElement>(".detail-wrap");
    if (!art || !wrap) return;
    const fit = () => {
      const top = art.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
      art.style.height = `${Math.max(360, wrap.clientHeight - top - 4)}px`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    window.addEventListener("resize", fit);
    return () => (ro.disconnect(), window.removeEventListener("resize", fit));
  });
  useEffect(() => setOpened(null), [picked, view.read_at]);
  useEffect(() => {
    const close = () => setOpened(null);
    window.addEventListener("fct:squads-back", close);
    return () => window.removeEventListener("fct:squads-back", close);
  }, []);
  const [stage, setStage] = useState(0);
  const [texts, setTexts] = useFlag("fct.squads.texts", false);
  const list = view.combos;
  const s = list.find((x) => x.id === picked) ?? list[0];
  // L1 / R1 (Q / E) step through the squad tabs, like the game's own sub-tabs
  const tabsRef = useRef({ list, id: s?.id });
  tabsRef.current = { list, id: s?.id };
  useEffect(() => {
    const on = (e: Event) => {
      const { list, id } = tabsRef.current;
      if (list.length < 2) return;
      const i = Math.max(0, list.findIndex((x) => x.id === id));
      setPicked(list[(i + (e as CustomEvent<number>).detail + list.length) % list.length].id);
    };
    window.addEventListener("fct:squads-session", on);
    return () => window.removeEventListener("fct:squads-session", on);
  }, []);
  // the stage being played now opens first
  const nowStage = s ? Math.max(0, s.stages.findIndex((st) => st.from <= s.played + 1 && (st.to == null || s.played + 1 <= st.to))) : 0;
  useEffect(() => setStage(nowStage), [s?.id, nowStage, s?.stages.length]);
  // the picked session tab stays in view between the pinned Q and E
  useEffect(() => {
    document.querySelector(`.sq-sessions [data-sid="${s?.id}"]`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [s?.id]);
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
      {/* the session tabs (L2/R2) get the full row – the squad's facts sit on the pitch (user 2026-11-05) */}
      <div className="sq-toprow">
        {list.length > 1 && (
          <div className="cat-row sq-sessions-row">
            <PadHint ids={["l2"]} keys="Q" />
            <nav className="cat-tabs sq-sessions segs-bar" ref={stripRef} aria-label={t("squads.play.sessions")}>
            {list.map((x) => (
              <button key={x.id} data-sid={x.id} className={`seg ring ${x.id === s.id ? "is-on" : ""}`} aria-pressed={x.id === s.id} title={(x.quick != null ? "" : placeLabel(x.place, x.place_name) + " · ") + t("squads.play.objectives", { count: x.counted })} onClick={() => setPicked(x.id)}>
                <span className="ellip">
                  {x.id}. {x.quick != null ? t("squads.play.quickTab", { count: x.quick }) : placeLabel(x.place, x.place_name)}
                </span>
                <b>{x.counted}</b>
              </button>
            ))}
            </nav>
            <PadHint ids={["r2"]} keys="E" />
          </div>
        )}
      </div>
      <SwapCtx.Provider value={{ opened, setOpened }}>
      <article className="sq-event sq-session sq-v2" ref={artRef}>
        <div className="sq-main">
          <section className="sq-pitch-col">
            <header className="sq-pitch-head">
              <div className="sq-pitch-title">
                <h3 className="h1">
                  {s.quick != null
                    ? t("squads.play.quickTitle", { count: s.quick })
                    : s.rules_unread
                      ? t("squads.play.sessionUnread", { place })
                      : t("v2.sq.headline", { count: s.counted })}
                </h3>
                <span className="sq-pitch-sub">
                  {s.quick == null && !s.rules_unread && (s.rush_format ? t("squads.play.sessionRush", { place }) : place)}
                  {" · "}
                  <Why s={s} />
                </span>
              </div>
              <LockButton e={{ id: s.id, title: `${place} · ${s.title}`, squad: shown.squad, reqs: shown.reqs }} event={s.primary ?? s.items[0]?.event ?? 0} />
            </header>
            <LockBar />
            {s.rush_format && <p className="sq-muted">{t("squads.play.rush")}</p>}
            {s.rules && <p className="sq-rules">{t("squads.rules.chip", { range: `${s.rules.min_rating ?? 40}–${s.rules.max_rating ?? 99}` })}</p>}
            <AskCards s={s} prefs={prefs} onPrefs={onPrefs} />
            <Lineup s={s} shown={shown} />
          </section>
          {opened ? (
            <SwapPanel s={opened} e={shown} onClose={() => setOpened(null)} />
          ) : (
          <section className="panel ring tier-dense sq-colp">
            <header>
              <div>
                <span className="h4">{t("v2.sq.inSession")}</span>
                <span className="sq-muted">{t("squads.play.objectives", { count: s.counted })}</span>
              </div>
              <b className="num sq-colp-n">{s.counted}</b>
            </header>
            <div className="sq-colp-body">
              <div className="sq-texts-toggle">
                <button className="btn btn-quiet btn-s" aria-pressed={texts} onClick={() => setTexts(!texts)}>
                  {t(texts ? "squads.texts.hide" : "squads.texts.show")}
                </button>
              </div>
              {/* what the squad can't meet yet, and where to get it – at the top of the objectives (one view: not under the pitch) */}
              {s.squad && gaps(s.reqs, asked(s))
                .filter((r) => !(s.id === list[0].id && quick.some((q) => q.reqs.some((x) => x.met && reqLabel(x) === reqLabel(r)))))
                .map((r, i) => (
                  <Options key={i} r={r} />
                ))}
              <SessionList s={s} texts={texts} elsewhere={s.id === list[0].id ? elsewhere : undefined} />
            </div>
            <footer className="sq-colp-foot">
              <Keycap ps="↓" xb="↓" kb="↓" />
              {t("v2.sq.showing", { shown: s.items.filter((x) => !x.bonus).length, total: s.items.length, done: s.items.filter((x) => x.progress >= x.target).length })}
            </footer>
          </section>
          )}
          <BriefColumn s={s} stage={stage} onStage={setStage} quick={s.id === list[0].id ? quick : []} onPick={setPicked} />
        </div>
      </article>
      </SwapCtx.Provider>
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
function AllEvents({ view, prefs, onPrefs, filter, onFilter }: { view: SquadsView; prefs: SquadPrefs; onPrefs: (p: SquadPrefs) => void; filter: Filter; onFilter: (f: Filter) => void }) {
  const [current, pick] = useEventChoice(view);
  const list = filtered(view.events, filter);
  const e = current && list.some((x) => x.id === current.id) ? current : list[0] ?? null;
  const [open, setOpen] = useFlag("fct.squads.allOpen", false);
  return (
    <section className={open ? "sq-all open" : "sq-all folded"}>
      <div className="sq-all-head">
        <button className="sq-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="sq-fold-mark" aria-hidden="true" />
          <h3 className="sq-section-title">{t("squads.allEvents")}</h3>
          <small className="sq-muted">{t("squads.allEventsCount", { count: list.length })}</small>
        </button>
        <FilterChips value={filter} onPick={onFilter} view={view} />
        {open && list.length > 0 && <EventSelect list={list} value={e?.id ?? null} label={t("squads.events")} onPick={(id) => id != null && pick(id)} />}
      </div>
      {open && (e ? <Event e={e} prefs={prefs} onPrefs={onPrefs} /> : <p className="sq-muted">{t("squads.filter.empty")}</p>)}
    </section>
  );
}

export default function Squads() {
  const [view, busy, setPrefs] = useSquads();
  const [settings, setSettings] = useState(false);
  const [filter, setFilter] = useFilter();
  if (!view) return <PlanSkeleton />;
  const prefs = view.prefs ?? defaultSquadPrefs;
  const formations = Array.from(new Set(FORMATIONS.concat((view.combos ?? []).flatMap((c) => (c.squad ? [c.squad.formation] : [])))));
  return (
    <EditCtx.Provider value={{ prefs, onPrefs: setPrefs, club: view.club }}>
    <SubProvider prefs={prefs} onPrefs={setPrefs}>
    <section className="sq">
      <header className="sq-head" title={view.read_at ? t("squads.read", { age: formatAge(view.read_at) }) : t("squads.notYet")}>
        {busy && (
          <small className="sq-muted sq-read">
            <span className="ml-loading inline">{t("squads.building", { count: view.club_players })}</span>
          </small>
        )}
        {!view.needs_sync && <PlayPick view={view} prefs={prefs} onPrefs={setPrefs} filter={filter} />}
        <button className={`btn btn-s btn-secondary ring ${settings ? "is-on" : ""}`} aria-expanded={settings} onClick={() => setSettings(!settings)} title={t("squads.ratingBeta")}>
          {t("squads.settings")} · {t(GOALS.find(([g]) => g === (prefs.goal ?? "progress"))?.[1] ?? "squads.goal.progress")}
        </button>
      </header>
      {settings && <Settings prefs={prefs} onChange={setPrefs} formations={formations} />}
      <Notes view={view} busy={busy} />
      <Sessions view={view} prefs={prefs} onPrefs={setPrefs} />
      {!view.needs_sync && view.club.length > 0 && <MustPick view={view} prefs={prefs} onChange={setPrefs} />}
      {view.events.length > 0 && <AllEvents view={view} prefs={prefs} onPrefs={setPrefs} filter={filter} onFilter={setFilter} />}
      <SavedSquads />
    </section>
    </SubProvider>
    </EditCtx.Provider>
  );
}

/** The formations to pick from (EA's names, as the squad shows them). */
const FORMATIONS = ["4-3-1-2", "4-4-1-1 (2)", "4-4-1-1", "4-3-3", "4-3-3 (2)", "4-3-3 (3)", "4-3-3 (4)", "4-4-2", "4-4-2 (2)", "4-2-3-1", "4-2-3-1 (2)", "4-1-2-1-2", "4-1-2-1-2 (2)", "4-2-2-2", "4-5-1", "4-5-1 (2)", "4-1-4-1", "4-2-4", "4-2-1-3", "3-4-1-2", "3-4-2-1", "3-4-3", "3-5-2", "3-1-4-2", "5-3-2", "5-2-3", "5-4-1", "5-2-1-2"];

/** The side panel's quick overview: what to play now (the first session – the user's pick or
 *  Auto), the stage of the plan, what counts and the XI – one narrow column. */
/** The first time the plan is worked out: its shape, with what is happening named. */
function PlanSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`sq-skeleton ${compact ? "compact" : ""}`} aria-busy="true">
      <p className="ml-loading">{t("squads.loading")}</p>
      <div className="sq-skel-tabs">
        {[0, 1, 2].map((i) => (
          <span key={i} />
        ))}
      </div>
      <div className="sq-skel-split">
        <div className="sq-skel-col">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} />
          ))}
        </div>
        <div className="sq-skel-pitch" />
      </div>
    </div>
  );
}

/** "For anyone" in the brief: the first few (what asks most of one match first). */
const ANYONE_SHOWN = 4;

/** The match brief (user 2026-11-01): before the match in broad strokes, in it something specific
 *  to go for, by player. In a match only the second half shows. */
/** A controller hint next to a tab row: PlayStation / Xbox glyphs with a controller, keys without. */
const PAD_NAMES: Record<string, [string, string]> = { l1: ["L1", "LB"], r1: ["R1", "RB"], l2: ["L2", "LT"], r2: ["R2", "RT"], left: ["←", ""], right: ["→", ""] };
/** PlayStation first, then Xbox (layout kept for callers that pass one) */
function PadHint({ ids, keys }: { ids: ("l1" | "r1" | "l2" | "r2" | "left" | "right")[]; keys: string }) {
  return (
    <span className="sq-pad-hint" aria-hidden="true">
      {ids.map((id, i) => <Keycap key={id} ps={PAD_NAMES[id][0]} xb={PAD_NAMES[id][1] || PAD_NAMES[id][0]} kb={i === 0 ? keys : undefined} />)}
    </span>
  );
}


/** A task with a requirement on the doer as one line – "Score from outside the box · with a 4★ weak foot player · 2 left" –
 *  and, opened (click / ✕ on the focused line), who in the XI can do it, attackers first. Never one player named for it. */
function ReqTaskLine({ x, s }: { x: BriefTask; s: SessionPlan }) {
  const [open, setOpen] = useState(false);
  const r = x.req != null ? s.reqs[x.req] : undefined;
  const who = x.who ?? [];
  return (
    <div className={`brief-req ${open ? "open" : ""}`}>
      <button type="button" data-f className="bl brief-req-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ic">{t("v2.sq.tagReq")}</span>
        <span className="ellip" title={r ? `${x.text} · ${reqLabel(r)}` : x.text}>
          <b className="strong">{x.text}</b>
          {r && <span className="muted"> · {reqLabel(r)}</span>}
        </span>
        <span className="t-13 muted nowrap">
          <b className="num t-15">{x.left}</b> {t("v2.sq.left")}
          <span className="sq-gap-caret" aria-hidden="true" />
        </span>
      </button>
      {open && (
        <ul className="brief-req-who">
          {who.length === 0 && <li className="muted t-13">{t("v2.sq.reqNobody")}</li>}
          {who.map((w, i) => (
            <li key={i}>
              <span className="tag">{w.pos}</span>
              <span className="strong">{w.name}</span>
              {w.bench && <span className="faint t-12">{t("v2.sq.tagSub")}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The match brief column of the Objectives screen (mockup 06), always open: before the match (XI, buys, kits, TIFOs,
 *  the bench), what each player has to do with how many are left, the squad changes as objectives finish (a stage
 *  opens on the pitch when picked), and the evolutions with their sub-on minute. Real plan data only. */
function BriefColumn({ s, stage, onStage, quick, onPick }: { s: SessionPlan; stage: number; onStage: (k: number) => void; quick: SessionPlan[]; onPick: (id: number) => void }) {
  const subs = useContext(SubCtx);
  const edit = useContext(EditCtx);
  const seen = useSquadSeen();
  const bench = benchOf(s);
  const b = s.brief;
  const byKey = new Map((edit?.club ?? []).map((c) => [c.key, c]));
  const ready = !!seen?.complete && seen.missing.length === 0;
  const tag = (x: NonNullable<SessionPlan["brief"]>["before"][number]): [string, string] => {
    if (x.kind === "squad" || x.kind === "ready") return ["XI", ""];
    if (x.kind === "buy" || x.kind === "rush_buy") return [t("v2.sq.tagBuy"), "buy"];
    if (x.kind === "use") return [/tifo/i.test(x.text) ? "TIFO" : t("v2.sq.tagKit"), ""];
    if (x.kind === "bench") return [t("v2.sq.tagSub"), ""];
    if (x.kind === "rush") return ["RUSH", ""];
    if (x.kind === "unread") return ["!", "warn"];
    return [t("v2.sq.tagRule"), ""];
  };
  const before = (x: NonNullable<SessionPlan["brief"]>["before"][number]) => {
    switch (x.kind) {
      case "squad":
        return (
          <>
            <span>{t("v2.sq.formation", { formation: x.text })}</span>
            {x.count != null && (
              <span className="faint t-13 nowrap">
                <b className="num">{x.count}</b> {t("v2.sq.changes")}
              </span>
            )}
          </>
        );
      case "ready":
        return <span>{t("brief.ready", { formation: x.text })}</span>;
      case "buy":
      case "rush_buy":
        return (
          <>
            <span>
              {t("v2.sq.buy")} <b className="strong">{x.text}</b>
            </span>
            {x.count != null ? (
              <span className="row nowrap" style={{ gap: 6 }}>
                <i className="coin" />
                <b className="num">{num(x.count)}</b>
              </span>
            ) : (
              <span className="faint t-13">{t("squads.slot.search")}</span>
            )}
          </>
        );
      case "use":
        return <span>{x.text}</span>;
      case "bench":
        return <span>{bench.map((p) => `${p.name} ${subs.minute(p.key)}:00`).join(", ") || x.text}</span>;
      case "rush":
        return <span>{t("brief.rush", { card: x.text })}</span>;
      case "rules":
        return <span>{t("brief.rules", { range: x.text })}</span>;
      case "cap":
        return <span>{t("brief.cap", { rating: x.text, count: x.count ?? 1 })}</span>;
      case "unread":
        return <span>{t("brief.unread", { event: x.text })}</span>;
    }
  };
  const evos = s.evos ?? [];
  return (
    <section className="panel ring sq-colp sq-briefcol" aria-label={t("brief.title")}>
      <header>
        <div>
          <span className="h4">{t("brief.title")}</span>
          <span className="faint t-13">
            {t("v2.sq.alsoPanel")} <Keycap ps="Create ×2" xb="View ×2" kb="Ctrl+Shift+M" />
          </span>
        </div>
        {ready && <span className="chip done">{t("v2.sq.ready")}</span>}
      </header>
      <div className="sq-colp-body">
        {b && b.before.length > 0 && (
          <div className="brief-sec">
            <span className="eyebrow">{t("brief.before")}</span>
            {b.before.map((x, i) => {
              const [label, tone] = tag(x);
              return (
                <div key={i} className="bl">
                  <span className={`ic ${tone}`}>{label}</span>
                  {before(x)}
                </div>
              );
            })}
          </div>
        )}
        {b && (b.players.length > 0 || b.anyone.length > 0 || (b.reqs?.length ?? 0) > 0) && (
          <div className="brief-sec">
            <span className="eyebrow">{t("v2.sq.yourPlayers")}</span>
            {(b.reqs ?? []).map((x, k) => (
              <ReqTaskLine key={`req-${k}`} x={x} s={s} />
            ))}
            {b.players.flatMap((p) =>
              p.tasks.map((x, k) => (
                <div key={`${p.name}-${k}`} className="bl">
                  <span className="ic">{k === 0 ? p.pos : ""}</span>
                  <span className="ellip" title={x.text}>
                    {k === 0 && <b className="strong">{p.name}</b>}
                    {k === 0 ? " · " : ""}
                    <span className="muted">{x.text}</span>
                  </span>
                  <span className="t-13 muted nowrap">
                    <b className="num t-15">{x.left}</b> {t("v2.sq.left")}
                  </span>
                </div>
              )),
            )}
            {b.anyone.slice(0, ANYONE_SHOWN).map((x, k) => (
              <div key={`any-${k}`} className="bl">
                <span className="ic">{t("v2.sq.tagAny")}</span>
                <span className="ellip" title={x.text}>
                  {x.text}
                </span>
                <span className="t-13 muted nowrap">
                  <b className="num t-15">{x.left}</b> {t("v2.sq.left")}
                </span>
              </div>
            ))}
          </div>
        )}
        {!b && <p className="sq-muted">{t("brief.nothing")}</p>}
        {(s.stages.length > 1 || quick.length > 0) && (
          <div className="brief-sec">
            <span className="eyebrow">{t("v2.sq.changesAsDone")}</span>
            {s.stages.map((st, k) => (
              <button key={k} data-f className={`stage-line ${stage === k ? "is-sel" : ""}`} onClick={() => onStage(k)} aria-pressed={stage === k}>
                <span className="when">{st.to == null ? t("squads.plan.from", { from: st.from }) : st.from === st.to ? t("squads.plan.one", { n: st.from }) : t("squads.plan.range", { from: st.from, to: st.to })}</span>
                <span className="col" style={{ gap: 4 }}>
                  {st.swaps.length === 0 ? (
                    <span className="muted">{t("v2.sq.thisXi")}</span>
                  ) : (
                    st.swaps.map((w, i) => (
                      <span key={i} className="swap">
                        {w.out_name && <span className="muted">{w.out_name}</span>}
                        {w.out_name && <span aria-hidden="true">→</span>}
                        <b className="strong">{w.in_name}</b>
                        <span className="tag">{w.pos}</span>
                      </span>
                    ))
                  )}
                </span>
              </button>
            ))}
            {quick.map((q) => (
              <button key={q.id} className="stage-line" onClick={() => onPick(q.id)}>
                <span className="when">{q.id}.</span>
                <span className="muted">{t("squads.plan.quick", { count: q.quick ?? 1, id: q.id })}</span>
              </button>
            ))}
          </div>
        )}
        {evos.length > 0 && (
          <div className="brief-sec">
            <span className="eyebrow">{t("v2.sq.evosSub")}</span>
            {evos.map((e, i) => {
              const c = byKey.get(e.key);
              const card: FutCardData = { name: e.player, rating: e.rating ?? c?.rating ?? null, position: e.pos ?? c?.positions[0] ?? null, rareflag: c?.rareflag ?? null, defId: c?.def_id ?? null };
              const minute = e.start ? null : subs.minute(e.key);
              return (
                <div key={i} className="evo">
                  <FaceChip card={card} s={44} pos={e.pos} />
                  <span className="col" style={{ gap: 3, minWidth: 0 }}>
                    <b className="strong t-15">{e.player}</b>
                    <span className="muted t-13 ellip">{t("v2.sq.evoLine", { evo: e.name, level: e.level, levels: e.levels, count: e.matches_left })}</span>
                  </span>
                  {minute != null ? <span className="tag accent"><b className="num">{minute}:00</b></span> : <span className="tag ink">XI</span>}
                </div>
              );
            })}
          </div>
        )}
        <p className="sq-muted t-12">{t("squads.plan.note")}</p>
      </div>
    </section>
  );
}

export function MatchBriefView({ s, inMatch = false }: { s: SessionPlan; inMatch?: boolean }) {
  const subs = useContext(SubCtx);
  const seen = useSquadSeen();
  const bench = benchOf(s);
  const b = s.brief;
  if (!b) return null;
  // live squad check (the game's Squad screen read): who is in, who still has to come in
  const missing = seen?.complete ? new Set(seen.missing.map((m) => m.name)) : null;
  const confirmed = seen ? new Set(seen.confirmed) : null;
  const squadCheck = (x: MatchBrief["before"][number]) => {
    if (!seen?.complete || (x.kind !== "squad" && x.kind !== "ready")) return null;
    return seen.missing.length === 0 ? (
      <small className="sq-check ok">{t("brief.check.ok")}</small>
    ) : (
      <small className="sq-check">{t("brief.check.list", { count: seen.missing.length, names: seen.missing.map((m) => m.name + " (" + m.pos + ")").join(", ") })}</small>
    );
  };
  const step = (x: MatchBrief["before"][number]) => {
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
        return t("brief.benchEach", { names: bench.map((b) => `${b.name} ${subs.minute(b.key)}:00`).join(", ") || x.text });
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
  };
  // the step's own subject (formation, card, kit, names) in bold, the wording around it regular
  const strong = (x: MatchBrief["before"][number]) => {
    const text = step(x);
    const key = x.kind === "bench" ? bench.map((b) => `${b.name} ${subs.minute(b.key)}:00`).join(", ") || x.text : x.text;
    const at = key ? text.indexOf(key) : -1;
    if (at < 0) return text;
    return (
      <>
        {text.slice(0, at)}
        <b>{key}</b>
        {text.slice(at + key.length)}
      </>
    );
  };
  const task = (x: BriefTask, k: number) => (
    <li key={k}>
      <span>{x.text}</span>
      {x.left > 1 && <small>{t("brief.left", { count: x.left })}</small>}
    </li>
  );
  const more = Math.max(0, b.anyone.length - ANYONE_SHOWN);
  return (
    <section className={`sq-brief ${inMatch ? "in-match" : ""}`} aria-label={t("brief.title")}>
      {!inMatch && b.before.length > 0 && (
        <>
          <h4>{t("brief.before")}</h4>
          <ol className="sq-brief-before">
            {b.before.map((x, i) => (
              <li key={i} className={x.kind}>
                <span className="sq-brief-n" aria-hidden="true">
                  {i + 1}
                </span>
                <span>
                  {strong(x)}
                  {squadCheck(x)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      <h4>{t("brief.during")}</h4>
      {b.players.length === 0 && b.anyone.length === 0 && !b.reqs?.length && <p className="sq-muted">{t("brief.nothing")}</p>}
      {(b.reqs ?? []).map((x, k) => (
        <ReqTaskLine key={`req-${k}`} x={x} s={s} />
      ))}
      <ul className="sq-brief-players">
        {b.players.map((p, i) => (
          <li key={i}>
            <p className="sq-brief-who">
              <b>{p.name}</b> <span>{p.bench ? t("brief.fromBench", { pos: p.pos }) : p.pos}</span>
              {!p.bench && (confirmed?.has(p.name) || (missing && !missing.has(p.name)) ? <span className="sq-check-mark" title={t("brief.check.in")}>✓</span> : missing?.has(p.name) ? <span className="sq-check-mark miss" title={t("brief.check.out")}>✕</span> : null)}
            </p>
            <ul>{p.tasks.map(task)}</ul>
          </li>
        ))}
        {b.anyone.length > 0 && (
          <li>
            <p className="sq-brief-who">
              <b>{t("brief.anyone")}</b>
            </p>
            <ul>
              {b.anyone.slice(0, ANYONE_SHOWN).map(task)}
              {more > 0 && <li className="sq-brief-more">{t("brief.more", { count: more })}</li>}
            </ul>
          </li>
        )}
      </ul>
    </section>
  );
}

export function SquadQuick({ inMatch = false }: { inMatch?: boolean }) {
  const [view, busy, setPrefs] = useSquads();
  const [k, setK] = useState(0);
  if (!view) return <PlanSkeleton compact />;
  const list = view.combos;
  const s = list[Math.min(k, list.length - 1)] ?? null;
  const step = (d: number) => setK((Math.min(k, list.length - 1) + d + list.length) % list.length);
  const st = s?.stages.find((x) => x.from <= s.played + 1 && (x.to == null || s.played + 1 <= x.to)) ?? null;
  const shown = s && st ? { id: s.id, reqs: st.reqs, squad: st.squad } : s;
  return (
    <EditCtx.Provider value={{ prefs: view.prefs ?? defaultSquadPrefs, onPrefs: setPrefs, club: view.club }}>
    <SubProvider prefs={view.prefs ?? defaultSquadPrefs} onPrefs={setPrefs}>
    <div className="ml-frame sq-quick">
      <header className="ml-head">
        <span className="eyebrow">{t("brief.title")}</span>
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
      {!inMatch && <Notes view={view} busy={busy} />}
      {s && inMatch && <MatchBriefView s={s} inMatch />}
      {s && !inMatch && (
        <>
          <MatchBriefView s={s} />
          {st && (
            <p className="sq-muted sq-brief-stage">
              {st.to == null ? t("squads.plan.from", { from: st.from }) : t("squads.plan.range", { from: st.from, to: st.to })}
              {st.to != null && <> · {t("squads.plan.nextChange", { count: Math.max(0, st.to - s.played) })}</>}
            </p>
          )}
          <LockBar />
          {shown && <Lineup s={s} shown={shown} compact />}
          <details className="sq-brief-all">
            <summary>{t("brief.all", { count: s.items.length })}</summary>
            <SessionList s={s} compact />
          </details>
          {gaps(s.reqs, asked(s)).map((r, i) => (
            <Options key={i} r={r} />
          ))}
        </>
      )}
    </div>
    </SubProvider>
    </EditCtx.Provider>
  );
}
