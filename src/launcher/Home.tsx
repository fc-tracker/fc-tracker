// The launcher's home (brand v2, design/d-draft-2/01-launcher): a FUT-17 tile menu. One 2×2 hero
// (what to play now: the session's XI and its objectives, with staged cards), the Champions and Gallery
// image tiles, four satellites (Best value, Planner, Match reminders, Club · best meta) and the rail
// (status + what's new) that the launcher passes in. Every tile opens the overlay on its section.
// Real data only – a tile with nothing to show says why (sync first, tracker off …), never invents.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, events, type BestValue, type GalleryCategory, type GalleryStatus, type RemindPrefs } from "../api";
import { champsClock, RANKS, REWARDS, weekendStats, type ChampsData } from "../championsData";
import { getLocale, t } from "../i18n";
import type { SessionPlan, SquadsView } from "../squadsData";
import { Bar, Chip, Coin, FaceChip, FutCard, Gem, GToken, Num, Rank, Score, Switch, Tag, Ticks, ToGrade, Token, fmt } from "../ui";
import { clubCard, galleryCard, slotCard } from "./cards";

type Data = {
  squads: SquadsView | null;
  champs: ChampsData | null;
  champsOn: boolean | null;
  reminders: RemindPrefs | null;
  gallery: GalleryStatus | null;
  overview: GalleryCategory[] | null;
  /** undefined = still calculating, null = nothing to plan */
  value: BestValue | null | undefined;
};

/* Home's last data, kept for the next visit and the next start (user 2026-11-05: "no changes – then it must not
   load"): every tile shows it at once; a visit refreshes it silently, and FC-Tracker's rebuild overlay shows only when
   a new plan can come (a sync, new objectives, a squad change) */
const HOME_KEY = "fct.home.data";
type Kept = Pick<Data, "squads" | "champs" | "gallery" | "overview" | "value">;
let kept: Kept = (() => {
  try {
    const s = localStorage.getItem(HOME_KEY) ?? localStorage.getItem("fct.home.plan");
    const v = s ? JSON.parse(s) : null;
    return v && "squads" in v ? (v as Kept) : { squads: v as SquadsView | null, champs: null, gallery: null, overview: null, value: undefined };
  } catch {
    return { squads: null, champs: null, gallery: null, overview: null, value: undefined };
  }
})();
let saveTimer = 0;
const keep = (p: Partial<Kept>) => {
  kept = { ...kept, ...p };
  // one write after a burst of answers (the plan is large)
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(HOME_KEY, JSON.stringify(kept));
      localStorage.removeItem("fct.home.plan");
    } catch {}
  }, 400);
};
const same = (a: unknown, b: unknown) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/** Everything the tiles show, refreshed when the app's data changes (sync, a read, a plan). */
function useHomeData(): [Data, (p: Partial<Data>) => void, boolean] {
  const [d, setD] = useState<Data>({ ...kept, champsOn: null, reminders: null });
  // a tile changes only when its data really changed (no flicker on a visit with nothing new)
  const patch = (p: Partial<Data>) =>
    setD((x) => {
      const changed = (Object.keys(p) as (keyof Data)[]).some((k) => !same(x[k], p[k]));
      if (!changed) return x;
      const { champsOn: _c, reminders: _r, ...rest } = p;
      keep(rest as Partial<Kept>);
      return { ...x, ...p };
    });
  // a new plan being worked out while the last one shows (FC-Tracker's rebuild overlay over it)
  const [planning, setPlanning] = useState(false);
  useEffect(() => {
    // visible = an expected change (after a sync / new objectives): the overlay; a visit refreshes silently
    const squads = (visible: boolean) => {
      if (visible || !kept.squads) setPlanning(!!kept.squads);
      api
        .squadsPlan()
        .then((squads) => patch({ squads }))
        .catch(() => {})
        .finally(() => setPlanning(false));
    };
    const champs = () => api.championsData().then((champs) => patch({ champs })).catch(() => {});
    const gallery = () => {
      api.galleryStatus().then((gallery) => patch({ gallery })).catch(() => {});
      api.galleryOverview().then((overview) => patch({ overview })).catch(() => {});
      api.bestValue().then((value) => patch({ value })).catch(() => {});
    };
    const prefs = () =>
      api
        .uiPrefs()
        .then((p) => patch({ champsOn: p.champions === true, reminders: p.reminders ?? { on: true, at: [0, 45], sub_at: 70 } }))
        .catch(() => {});
    squads(false);
    champs();
    gallery();
    prefs();
    const un = [
      events.onSyncDone(() => {
        squads(true);
        gallery();
      }),
      events.onSquadsChanged(() => squads(true)),
      events.onChampions((c) => patch({ champs: c })),
      events.onGalleryUpdated(gallery),
    ];
    return () => un.forEach((u) => u.then((f) => f()));
  }, []);
  return [d, patch, planning];
}

/** The width of an element (cards size to their tile) – a callback ref, so it works for an element that appears later. */
function useSize<T extends HTMLElement>(): [(el: T | null) => void, { w: number; h: number }] {
  const ro = useRef<ResizeObserver | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ref = useCallback((el: T | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.current.observe(el);
  }, []);
  return [ref, size];
}

const open = (section: string) => () => void api.openOverlay(section).catch(() => {});

/** Exactly one game cursor on the home: the hero has it until another tile is pointed at or focused. */
const FocusCtx = createContext<{ id: string; set: (id: string) => void }>({ id: "objectives", set: () => {} });

/** A tile's own height as `--th` (px), so its big numbers grow with the room the grid gives it (review LA-3: no dead
 *  space in a tall tile). Written straight to the style – no re-render; the number's share of the height is < 1, so a
 *  row sized by its content settles at once. */
const heightVar = (() => {
  const ro =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((es) => es.forEach((e) => (e.target as HTMLElement).style.setProperty("--th", `${Math.round(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height)}px`)));
  return (el: HTMLElement | null) => void (el && ro?.observe(el));
})();

/** A tile: the whole tile is the button (✕ / A), the cursor is the game's own. */
function Tile({ id, className, section, label, children }: { id: string; className: string; section: string; label: string; children: ReactNode }) {
  const f = useContext(FocusCtx);
  return (
    <div
      ref={heightVar}
      className={`tile ring lh-t ${className} ${f.id === id ? "is-focus" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      data-f=""
      onMouseEnter={() => f.set(id)}
      onFocus={(e) => e.target === e.currentTarget && f.set(id)}
      onClick={open(section)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(section)();
        }
      }}
    >
      {children}
    </div>
  );
}

/** A control inside a tile must not open the overlay. */
const Inside = ({ children }: { children: ReactNode }) => (
  <span className="lh-inside" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
    {children}
  </span>
);

export default function Home({ rail }: { rail: ReactNode }) {
  const [d, patch, planning] = useHomeData();
  const session = d.squads?.combos?.[0] ?? null;
  const [focus, setFocus] = useState("hero");
  return (
    <FocusCtx.Provider value={{ id: focus, set: setFocus }}>
    <div className="lh">
      <div className="lh-tiles">
        <HeroTile squads={d.squads} s={session} planning={planning} />
        <ChampionsTile data={d.champs} on={d.champsOn} onSwitch={(on) => api.setChampionsTracking(on).then((p) => patch({ champsOn: p.champions === true })).catch(() => {})} />
        <GalleryTile status={d.gallery} overview={d.overview} />
        <ValueTile value={d.value} />
        <PlannerTile value={d.value} />
        <RemindersTile s={session} prefs={d.reminders} onSwitch={(on) => d.reminders && api.setMatchReminders({ ...d.reminders, on }).then((u) => u.reminders && patch({ reminders: u.reminders })).catch(() => {})} />
        <MetaTile squads={d.squads} />
      </div>
      <aside className="lh-rail">{rail}</aside>
    </div>
    </FocusCtx.Provider>
  );
}

/* ───────────── the hero: what to play now ───────────── */

function HeroTile({ squads, s, planning = false }: { squads: SquadsView | null; s: SessionPlan | null; planning?: boolean }) {
  const [ref, box] = useSize<HTMLDivElement>();
  const xi = s?.squad;
  // the cards fill the stage (review LA-2: never a row of small cards beside empty room): as tall as the space under
  // the text allows (FUT card ≈ 1 : 1.42), and as many as fit side by side at that height – three to five – the ones
  // that carry the most objectives (then the strongest) first
  const GAP = 14;
  const byH = Math.max(84, Math.min(240, Math.floor((box.h - 16) / 1.42)));
  const n = Math.max(3, Math.min(5, Math.floor((box.w + GAP) / (byH * 0.9 + GAP))));
  const cw = Math.max(84, Math.min(byH, Math.floor((box.w - GAP * (n - 1)) / (1 + 0.9 * (n - 1)))));
  const staged = xi
    ? [...xi.slots].sort((a, b) => b.counts_for.length - a.counts_for.length || b.rating - a.rating).slice(0, n)
    : [];
  const chips = (s?.brief?.before ?? []).filter((b) => b.kind === "buy" || b.kind === "use" || b.kind === "bench" || b.kind === "rush" || b.kind === "rush_buy");
  const chipLabel = (k: string) => t(k === "buy" || k === "rush_buy" ? "lh.chip.buy" : k === "bench" ? "lh.chip.sub" : k === "rush" ? "lh.chip.rush" : "lh.chip.use");
  return (
    <Tile id="hero" className={`hero t-hero ${planning && squads ? "rebuilding" : ""}`} section="objectives" label={t("lh.obj.open")}>
      {planning && squads && (
        <div className="sq-rebuild" role="status">
          <span className="sq-rebuild-mark">FC-Tracker</span>
          <span className="ml-loading">{t("v2.sq.rebuilding")}</span>
        </div>
      )}
      {!squads ? (
        <p className="lh-wait">{t("lh.obj.loading")}</p>
      ) : !s ? (
        <>
          <span className="eyebrow accent">{t("lh.obj.eyebrow")}</span>
          <span className="display lh-hero-title">{squads.needs_sync ? t("lh.obj.syncTitle") : t("lh.obj.noneTitle")}</span>
          <span className="t-15 muted">{squads.needs_sync ? t("lh.obj.syncText") : t("lh.obj.noneText")}</span>
        </>
      ) : (
        <>
          <span className="eyebrow accent">{s.place_name}</span>
          <span className="display lh-hero-title">
            {s.rush_format ? t("lh.obj.rush") : t("lh.obj.xi")}
            <br />
            {t("lh.obj.count", { count: s.counted })}
          </span>
          {xi ? (
            <span className="t-15 muted lh-hero-sub">
              {xi.formation} · {t("lh.obj.chem", { count: xi.chem })}
              {xi.buys > 0 ? (
                <>
                  {" · "}
                  {/* no recent price = no "for 0 coins" (user 2026-11-05): the count alone, like the overlay */}
                  {xi.cost > 0 ? (
                    <>
                      {t("lh.obj.buys", { count: xi.buys })} <Coin /> <b className="strong">{fmt(xi.cost)}</b>
                    </>
                  ) : (
                    t("squads.buysCount", { count: xi.buys })
                  )}
                </>
              ) : (
                <> · {t("lh.obj.allOwned")}</>
              )}
            </span>
          ) : s.rules_unread ? (
            <span className="t-15 muted">{t("lh.obj.rulesUnread")}</span>
          ) : null}
          {chips.length > 0 && (
            <div className="row wrap lh-chips">
              {chips.slice(0, 5).map((b, i) => (
                <Chip key={i} tone={b.kind === "buy" || b.kind === "rush_buy" ? "accent-soft" : "line"}>
                  {chipLabel(b.kind)} · {b.text}
                </Chip>
              ))}
            </div>
          )}
          <div className="lh-hero-cards" ref={ref}>
            <div className="lh-hero-stage">
              {staged.map((p, i) => (
                <FutCard key={p.key ?? i} card={slotCard(p)} size={cw >= 140 ? "full" : "small"} w={i === 0 ? cw : Math.round(cw * 0.9)} toGet={!p.owned} />
              ))}
            </div>
          </div>
        </>
      )}
    </Tile>
  );
}

/* ───────────── Champions ───────────── */

const dayTime = (ms: number) =>
  new Intl.DateTimeFormat(getLocale(), { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

function ChampionsTile({ data, on, onSwitch }: { data: ChampsData | null; on: boolean | null; onSwitch: (on: boolean) => void }) {
  const run = data?.runs.length ? data.runs[data.runs.length - 1] : null;
  const st = run ? weekendStats(run) : null;
  const clock = champsClock(data, Date.now());
  const rank = st && st.wins > 0 ? Math.min(15, st.wins) - 1 : null;
  const reward = rank != null ? REWARDS[rank] : null;
  const toggle = (
    <Inside>
      <span className="row t-13 muted lh-switch">
        {t("lh.champs.tracker")}
        <Switch on={!!on} onChange={onSwitch} label={t("settings.champions")} />
      </span>
    </Inside>
  );
  return (
    <Tile id="champs" className="t-champ" section="champions" label={t("lh.champs.open")}>
      <div className="row between">
        <span className="eyebrow">{t("lh.champs.eyebrow")}</span>
        <Chip tone="beta">{t("lh.beta")}</Chip>
      </div>
      {st ? (
        <>
          <div className="row lh-champ-main">
            <Score a={st.wins} b={st.losses} className="num-xl" />
            {rank != null && reward && (
              <div className="row lh-rank">
                <Rank i={rank} got size="l" name={RANKS[rank]} />
                <div className="col">
                  <span className="h3">{RANKS[rank]}</span>
                  <span className="t-14 muted">
                    <Coin /> <b className="strong">{fmt(reward.coins)}</b> {t("lh.coins")} · <Token /> <b className="strong">{reward.tokens}</b> {t("lh.tokens")}
                  </span>
                </div>
              </div>
            )}
          </div>
          <Ticks items={st.form.map((o) => (o === "win" ? "w" : "l"))} />
        </>
      ) : on === false ? (
        <div className="col lh-champ-off">
          <span className="h3">{t("champs.news.title")}</span>
          <span className="t-14 muted">{t("champs.news.text")}</span>
        </div>
      ) : (
        <div className="col lh-champ-off">
          <span className="h3">{t("lh.champs.noneTitle")}</span>
          <span className="t-14 muted">{t("lh.champs.noneText")}</span>
        </div>
      )}
      <div className="tile-foot">
        <span className="t-13 muted">
          {clock.live
            ? t(clock.exact ? "lh.champs.ends" : "lh.champs.endsAbout", { when: dayTime(clock.ends) })
            : t(clock.exact ? "lh.champs.opens" : "lh.champs.opensAbout", { when: dayTime(clock.opens) })}
        </span>
        {toggle}
      </div>
    </Tile>
  );
}

/* ───────────── Gallery ───────────── */

function GalleryTile({ status, overview }: { status: GalleryStatus | null; overview: GalleryCategory[] | null }) {
  const sum = status?.summary ?? null;
  const sets = (overview ?? []).flatMap((c) => c.sets);
  // closest next grade among the sets that already have one
  const closest = sets
    .filter((s) => s.tracked && s.grade?.next && s.grade.points_to_next > 0)
    .sort((a, b) => (a.grade!.points_to_next ?? 0) - (b.grade!.points_to_next ?? 0))[0];
  // the strongest special in the user's Gallery stands on the stage (owned: placed in a lineup)
  const star = sets
    .flatMap((s) => s.lineup)
    .filter((c) => c.rareflag != null && c.rareflag > 1 && c.rating != null)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))[0];
  const done = sum?.sets?.[0] ?? sets.filter((s) => s.complete).length;
  const total = sum?.sets?.[1] ?? sets.length;
  return (
    <Tile id="gal" className="t-gal" section="gallery" label={t("lh.gal.open")}>
      {star && (
        <div className="lh-stage-card">
          <FutCard card={galleryCard(star)} size="small" w={124} />
          <span className="t-12 muted">{t("lh.gal.inGallery", { name: star.name ?? "" })}</span>
        </div>
      )}
      <span className="eyebrow">{t("lh.gal.eyebrow")}</span>
      {total > 0 ? (
        <>
          <span className="row base lh-gal-num">
            <Num value={done} size="xl" unit={t("lh.gal.sets", { total: fmt(total) })} />
          </span>
          <div className="col lh-gal-foot">
            {sum?.score != null && (
              <span className="row lh-gem-row">
                <Gem />
                <b className="num t-20">{fmt(sum.score)}</b>
                {sum.level != null && <span className="t-13 muted">{t("lh.gal.level", { level: sum.level })}</span>}
              </span>
            )}
            {closest && (
              <span className="t-13 muted">
                {t("lh.gal.closest")} <b className="strong">{closest.name}</b> <ToGrade to={closest.grade!.next!.grade} /> · {t("lh.gal.toGo", { points: fmt(closest.grade!.points_to_next) })}
              </span>
            )}
          </div>
        </>
      ) : (
        <span className="t-14 muted">{t("lh.gal.none")}</span>
      )}
    </Tile>
  );
}

/* ───────────── satellites ───────────── */

function ValueTile({ value }: { value: BestValue | null | undefined }) {
  const [a, b] = value?.plan.steps ?? [];
  return (
    <Tile id="value" className="t-sat" section="value" label={t("lh.value.open")}>
      <span className="eyebrow">{t("lh.value.eyebrow")}</span>
      {a ? (
        <>
          <Num value={a.coins_needed} size="m" unit={t("lh.coins")} />
          <span className="t-14 muted lh-named">
            <span className="ellip">{a.name}</span> <ToGrade to={a.grade} /> · <GToken /> {a.tokens}
          </span>
          <div className="row lh-faces">
            {a.buys.slice(0, 4).map((x, i) => (
              <FaceChip key={i} card={galleryCard(x.card)} s={52} />
            ))}
          </div>
          {b && (
            <div className="tile-foot">
              <span className="t-13 muted lh-named">
                <span className="ellip">
                  {t("lh.then")} {b.name}
                </span>{" "}
                <ToGrade to={b.grade} />
              </span>
              <span className="num t-15">{fmt(b.coins_needed)}</span>
            </div>
          )}
        </>
      ) : (
        <ValueEmpty value={value} />
      )}
    </Tile>
  );
}

/** Best value / Planner with nothing to plan: a named state with its reason (never an empty tile). */
function ValueEmpty({ value }: { value: BestValue | null | undefined }) {
  if (value === undefined) return <span className="t-14 muted lh-wait">{t("lh.value.loading")}</span>;
  const unpriced = value ? value.sets.reduce((n, v) => n + v.unpriced, 0) : 0;
  return (
    <div className="col lh-empty">
      <span className="tile-title">{value ? t("lh.value.none") : t("lh.value.noSets")}</span>
      <span className="t-14 muted">
        {!value ? t("lh.value.noData") : unpriced > 0 ? t("lh.value.noPrices", { count: unpriced }) : t("value.rowNothing")}
      </span>
    </div>
  );
}

function PlannerTile({ value }: { value: BestValue | null | undefined }) {
  const plan = value?.plan;
  const coins = value?.coins?.[0] ?? null;
  // the share of the coin balance stays out of pictures for the site (dev `?shot`)
  const share = plan && coins && !document.documentElement.hasAttribute("data-shot") ? plan.coins_needed / coins : null;
  return (
    <Tile id="planner" className="t-sat" section="planner" label={t("lh.plan.open")}>
      <span className="eyebrow">{t("lh.plan.eyebrow")}</span>
      {plan && plan.steps.length ? (
        <>
          <Num value={plan.tokens} size="m" unit={t("lh.tokens")} />
          <span className="t-14 muted">
            {t("lh.plan.for", { coins: fmt(plan.coins_needed) })}
            {share != null && <> · {t("lh.plan.share", { pct: (share * 100).toLocaleString(getLocale(), { maximumFractionDigits: 1 }) })}</>}
          </span>
          {share != null && <Bar value={Math.min(1, share)} size="thin" />}
          <div className="list lh-steps">
            {plan.steps.slice(0, 3).map((s) => (
              <div key={s.key} className="row between t-13">
                <span className="lh-named">
                  <b className="strong ellip">{s.name}</b> <ToGrade to={s.grade} />
                </span>
                <span className="num t-15">{fmt(s.coins_needed)}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <ValueEmpty value={value} />
      )}
    </Tile>
  );
}

const minute = (m: number) => (m === 0 ? t("settings.reminderLoad") : `${m}:00`);

function RemindersTile({ s, prefs, onSwitch }: { s: SessionPlan | null; prefs: RemindPrefs | null; onSwitch: (on: boolean) => void }) {
  const subs = [
    ...(s?.bench ?? []).map((b) => ({ name: b.name, what: b.objectives[0] ?? "", card: { name: b.name, rating: b.rating, position: b.pos, nation: b.nation || null } })),
    ...(s?.evos ?? []).filter((e) => !e.start && !e.in_xi).map((e) => ({ name: e.player, what: e.name, card: { name: e.player, rating: e.rating ?? null, position: e.pos ?? null, nation: e.nation ?? null } })),
  ];
  const sub = prefs?.sub_at ?? 70;
  const marks = [...(prefs?.at ?? [0, 45]), sub].filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y);
  const end = Math.max(90, ...marks);
  return (
    <Tile id="rem" className="t-sat" section="objectives" label={t("lh.rem.open")}>
      <span className="eyebrow">{t("settings.reminders")}</span>
      {subs.length > 0 ? (
        <span className="row lh-rem-title">
          <Tag tone="accent">
            <span className="num">{sub}:00</span>
          </Tag>
          <span className="tile-title ellip">{t("lh.rem.subOn", { name: subs.map((x) => x.name).slice(0, 2).join(", ") })}</span>
        </span>
      ) : (
        <span className="t-14 muted">{t("lh.rem.noSubs")}</span>
      )}
      <div className="lh-rem" aria-hidden="true">
        {marks.map((m) => (
          <i key={m} className={m === sub ? "a" : ""} style={{ left: `${(m / end) * 100}%` }} />
        ))}
        {marks.map((m) => (
          <span key={m} className={m === sub ? "a" : ""} style={{ left: `${(m / end) * 100}%` }}>
            {m === 45 ? "45:00" : minute(m)}
          </span>
        ))}
      </div>
      <div className="col lh-subs">
        {subs.slice(0, 2).map((x, i) => (
          <span key={i} className="row t-13 muted">
            <FaceChip card={x.card} s={36} />
            <span className="ellip">
              <b className="strong">{x.name}</b>
              {x.what && ` · ${x.what}`}
            </span>
          </span>
        ))}
      </div>
      <div className="tile-foot">
        <span className="t-13 muted">{t("lh.rem.everyMode")}</span>
        <Inside>
          <span className="row t-13 muted lh-switch">
            {prefs?.on ? t("settings.on") : t("settings.off")}
            <Switch on={!!prefs?.on} onChange={onSwitch} label={t("settings.reminders")} />
          </span>
        </Inside>
      </div>
    </Tile>
  );
}

function MetaTile({ squads }: { squads: SquadsView | null }) {
  const best = (squads?.club ?? [])
    .filter((c) => c.owned && !c.loan && c.meta && Object.keys(c.meta).length)
    .map((c) => {
      const [pos, m] = Object.entries(c.meta!).sort((a, b) => b[1] - a[1])[0];
      return { c, pos, m };
    })
    .sort((a, b) => b.m - a.m)
    .filter((x, i, a) => a.findIndex((y) => y.pos === x.pos) === i)
    .slice(0, 3);
  return (
    <Tile id="meta" className="t-sat" section="objectives" label={t("lh.meta.open")}>
      <span className="eyebrow">{t("lh.meta.eyebrow")}</span>
      <span className="t-13 muted">{t("lh.meta.sub")}</span>
      {best.length ? (
        <div className="list lh-meta">
          {best.map(({ c, pos, m }) => (
            <div key={c.key} className="row between t-14">
              <span className="row lh-meta-who">
                <FaceChip card={clubCard(c, pos)} s={40} pos={pos} />
                <b className="strong ellip">{c.name}</b>
              </span>
              <span className="num t-16">{m.toLocaleString(getLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="t-14 muted">{squads?.needs_sync ? t("lh.obj.syncText") : t("lh.meta.none")}</span>
      )}
    </Tile>
  );
}
