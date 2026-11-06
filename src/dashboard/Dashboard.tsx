/**
 * The dashboard (fc-tracker.com/dashboard) in brand v2 – mockup design/d-draft-2/11-dashboard.html: everything the
 * account holds on the server (api.fc-tracker.com/v1: me, sync parts, devices, saved squads) – the last Champions
 * weekend as the hero, the Gallery, objective sessions, the sets closest to their next grade, sync and devices – plus
 * the whole tracker and the profile (sign-in, delete account, export). Signed out it is the e-mail-code sign-in.
 * Every number comes from the account's synced data, computed by the same model as the app. Everything is free.
 */
import { useEffect, useState } from "react";
import { api, formatAge, type BestValue, type GalleryCategory, type GalleryStatus } from "../api";
import { LOCALE_NAMES, getLocale, t, useLocale, type Locale } from "../i18n";
import { useTheme } from "../theme";
import { SiteFooter, SiteHeader } from "./SiteChrome";
import { ClubPage, CreatorPage, Head, ObjectivesPage, OverlayPage, ROUTES, Shell, type Route } from "./Pages";
import { appSettings } from "../syncSettings";
import SyncConflict, { timeAgo } from "../SyncConflict";
import { Account } from "../AccountSettings";
import { SavedSquads } from "../Squads";
import { weekendLabel } from "../Champions";
import { devices, handoffState, syncedParts, useAccount, type CloudPart, type Device, type Part } from "../account";
import { REWARDS, rankFor, RANKS, shownScore, type ChampsData, type ChampsRun } from "../championsData";
import type { SquadsView } from "../squadsData";
import { Bar, Chip, Coin, Dot, Gem, GToken, Grade, Num, Panel, Rank, Score, Ticks, ToGrade, Token, fmt } from "../ui";


/* ?mock on a local host (dev preview, `serve site/dist`): the signed-in dashboard with sample data, so it can be
   checked offline without the live server. The account is account.ts's offline mock (devMock.ts mockAccountCall:
   profile, devices, export, delete); the data is the overlay's own sample club (devMock.ts – the Gallery of
   src/demoData.json, the real 12–3 weekend, the real objective plan), so both show the same numbers. */
const MOCK = typeof location !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && new URLSearchParams(location.search).has("mock");
const MOCK_AT = Date.now() - 4 * 60_000;
const MOCK_PARTS: Record<string, CloudPart> = {
  gallery: { version: 12, written_at: MOCK_AT, updated_at: MOCK_AT, device: "FC-Tracker app · Windows" },
  webapp: { version: 9, written_at: MOCK_AT, updated_at: MOCK_AT, device: "FC-Tracker app · Windows" },
  champions: { version: 4, written_at: MOCK_AT - 86_400_000, updated_at: MOCK_AT - 86_400_000, device: "FC-Tracker app · Windows" },
  settings: { version: 3, written_at: MOCK_AT, updated_at: MOCK_AT, device: "FC-Tracker Web · Chrome" },
};
function useData() {
  const acc = useAccount();
  const [gallery, setGallery] = useState<GalleryCategory[] | null>(null);
  const [status, setStatus] = useState<GalleryStatus | null>(null);
  const [value, setValue] = useState<BestValue | null>(null);
  const [champs, setChamps] = useState<ChampsData | null>(null);
  const [squads, setSquads] = useState<SquadsView | null>(null);
  const [parts, setParts] = useState<Record<string, CloudPart> | null>(null);
  const [devs, setDevs] = useState<Device[] | null>(null);
  // every sync may bring new data: read it all again
  useEffect(() => {
    if (MOCK) {
      void import("../devMock").then((m) => {
        setGallery(m.mockGallery);
        setStatus(m.mockStatus);
        void m.mockBestValue(null, null, null).then(setValue).catch(() => setValue(null));
        setChamps(m.mockChampions);
        setSquads(m.mockSquads());
      });
      setParts(MOCK_PARTS);
      devices().then(setDevs).catch(() => setDevs([]));
      return;
    }
    if (acc.status !== "in" || acc.sync.phase === "syncing") return;
    api.galleryOverview().then(setGallery).catch(() => setGallery([]));
    api.galleryStatus().then(setStatus).catch(() => setStatus(null));
    api.bestValue().then(setValue).catch(() => setValue(null));
    api.championsData().then(setChamps).catch(() => setChamps(null));
    api.squadsPlan().then(setSquads).catch(() => setSquads(null));
    syncedParts().then(setParts).catch(() => setParts({}));
    devices().then(setDevs).catch(() => setDevs([]));
  }, [acc.status, acc.sync.at, acc.sync.phase, acc.user?.id]);
  useEffect(() => {
    const on = () => api.championsData().then(setChamps).catch(() => {});
    window.addEventListener("fct-web-champions", on);
    return () => window.removeEventListener("fct-web-champions", on);
  }, []);
  return { gallery, status, value, champs, squads, parts, devs };
}

/** a tile: eyebrow title, an optional link on the right, the content */
function Tile({ title, action, className, children }: { title: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <Panel className={`dv-tile ${className ?? ""}`}>
      <div className="dv-tile-h">
        <span className="eyebrow">{title}</span>
        {action}
      </div>
      {children}
    </Panel>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => <p className="dv-muted">{children}</p>;

/* ------------------------------------------------------------------ Champions: the last weekend is the hero */

/** Every match of one weekend: number, result, score, how it ended, when. */
function WeekendMatches({ run }: { run: ChampsRun }) {
  const ms = [...run.matches].sort((a, b) => (a.n ?? 99) - (b.n ?? 99));
  return (
    <>
      {run.corrected && <Muted>{t("champs.corrected")}</Muted>}
      <ol className="dv-matches">
        {ms.map((m, i) => {
          const s = shownScore(m);
          return (
            <li key={i} className={m.outcome ?? ""}>
              <span className="num">{m.n ?? "–"}</span>
              <b>{m.outcome ? t(`champs.short.${m.outcome}`) : "…"}</b>
              <span className="num">{s.score ? <Score a={s.score[0]} b={s.score[1]} /> : ""}{m.extra_time ? ` ${t("champs.aet")}` : ""}</span>
              <small>
                {m.disconnect
                  ? t("champs.dnf")
                  : s.whenLeft
                    ? t("champs.whenLeft", { score: `${s.whenLeft[0]}–${s.whenLeft[1]}`, minute: s.minute ?? 0 })
                    : m.hub_only
                      ? t(run.corrected ? "champs.fromYou" : "champs.notSeen")
                      : new Date(m.started).toLocaleString(getLocale(), { weekday: "short", hour: "2-digit", minute: "2-digit" })}
              </small>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/* mockup 11: score, rank + rewards + best run, the weekend's state on the right, the ticks full width, the weekend
   line under; the ticks open the weekend's matches (everything tracked is clickable). */
function ChampionsHero({ data, open }: { data: ChampsData | null; open: () => void }) {
  const [shown, setShown] = useState(false);
  const runs = (data?.runs ?? []).filter((r) => r.matches.length > 0 || r.hub.wins + r.hub.losses > 0);
  if (!runs.length)
    return (
      <Tile title={t("dash.champions")} className="c12" action={<Chip tone="beta">{t("v2web.beta")}</Chip>}>
        <Muted>{t("dash.championsEmpty")}</Muted>
      </Tile>
    );
  const last = runs[runs.length - 1];
  const w = last.hub.wins, l = last.hub.losses;
  const rank = rankFor(w);
  const reward = w >= 1 ? REWARDS[Math.min(15, w) - 1] : null;
  const ms = [...last.matches].sort((a, b) => (a.n ?? 99) - (b.n ?? 99));
  const order = ms.map((m) => (m.outcome === "win" ? "w" : m.outcome ? "l" : "") as "w" | "l" | "");
  const bestRun = order.reduce((acc, o) => (o === "w" ? { cur: acc.cur + 1, best: Math.max(acc.best, acc.cur + 1) } : { cur: 0, best: acc.best }), { cur: 0, best: 0 }).best;
  const complete = w + l >= 15;
  const nextRank = !complete && w < 15 ? rankFor(w + 1) : null;
  const next = !complete && w < 15 ? { coins: REWARDS[w].coins - (reward?.coins ?? 0), tokens: REWARDS[w].tokens - (reward?.tokens ?? 0) } : null;
  const weekend = weekendLabel(last);
  const dnf = ms.some((m) => m.disconnect);
  return (
    <Panel cut="xl" signed className="dv-tile dv-hero c12">
      <div className="dv-tile-h">
        <span className="eyebrow">{t("v2web.dash.lastWeekend")}</span>
        <span className="row" style={{ gap: 10 }}>
          <Chip tone="beta">{t("v2web.beta")}</Chip>
          <button className="dv-link" onClick={open}>{t("dash.openTracker")}</button>
        </span>
      </div>
      <div className="dv-hero-row">
        <Score a={w} b={l} className="num-hero" />
        <div className="col dv-hero-rank">
          {rank && (
            <span className="row" style={{ gap: 12 }}>
              <Rank i={RANKS.indexOf(rank)} got size="m" name={rank} />
              <span className="dv-h2">{rank}</span>
            </span>
          )}
          <span className="dv-muted row" style={{ gap: 6, flexWrap: "wrap" }}>
            {reward && (
              <>
                <Coin /> {t("v2web.dash.coins", { n: fmt(reward.coins) })} · <Token /> {t("v2web.dash.tokens", { n: fmt(reward.tokens) })} ·
              </>
            )}{" "}
            {t("v2web.dash.bestRun", { n: bestRun })}
          </span>
        </div>
        {(complete || next) && (
          <div className="col dv-hero-side">
            {complete ? (
              <>
                <span className="dv-sec done-text">{t("v2web.dash.weekendComplete")}</span>
                <span className="dv-muted row" style={{ gap: 8 }}>
                  {rank && <Rank i={RANKS.indexOf(rank)} got size="s" name={rank} />}
                  <b className="strong">
                    {rank ? `${rank} · ` : ""}
                    <Score a={w} b={l} />
                  </b>
                </span>
              </>
            ) : (
              <>
                <span className="dv-sec">{t("v2web.dash.oneMoreWin")}</span>
                <span className="dv-muted row" style={{ gap: 6, flexWrap: "wrap" }}>
                  {nextRank && (
                    <>
                      <Rank i={RANKS.indexOf(nextRank)} size="s" name={nextRank} /> {nextRank} ·
                    </>
                  )}{" "}
                  <Coin /> +{fmt(next!.coins)} · <Token /> +{fmt(next!.tokens)}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      {order.length > 0 && (
        <button className="dv-ticks" aria-expanded={shown} title={t("champs.historyOpen")} onClick={() => setShown(!shown)}>
          <Ticks items={order} />
        </button>
      )}
      <span className="dv-small">
        {[weekend, t("v2web.dash.matches", { n: ms.length }), dnf ? t("champs.dnf") : null].filter(Boolean).join(" · ")}
      </span>
      {shown && <WeekendMatches run={last} />}
    </Panel>
  );
}

/* ------------------------------------------------------------------ club */

/** The synced club: how many players, the three best by FC-Tracker's meta rating, the coins (when read). */
function ClubTile({ view }: { view: SquadsView | null }) {
  const best = (view?.club ?? [])
    .filter((c) => c.owned)
    .map((c) => ({ name: c.name, meta: Math.max(0, ...Object.values(c.meta ?? {})) }))
    .filter((c) => c.meta > 0)
    .sort((a, b) => b.meta - a.meta)
    .slice(0, 3);
  return (
    <Tile title={t("v2web.dash.club")} className="c6">
      {!view || !view.club_players ? (
        <Muted>{t("v2web.dash.clubEmpty")}</Muted>
      ) : (
        <>
          <Num value={view.club_players} size="l" className="dv-big" />
          <span className="dv-muted">
            {t("v2web.dash.clubText")}
            {best.length > 0 && ` · ${t("v2web.dash.bestMeta")}`}
            {best.map((c, i) => (
              <span key={c.name}>
                {i ? " · " : " "}
                <b className="strong">{c.name}</b> {c.meta.toFixed(1)}
              </span>
            ))}
          </span>
          {view.coins != null && (
            <>
              <div className="hr" />
              <div className="row between">
                <span className="dv-muted">{t("v2web.dash.coinsLabel")}</span>
                <span className="row num dv-t20" style={{ gap: 6 }}>
                  <Coin /> {fmt(view.coins)}
                </span>
              </div>
            </>
          )}
        </>
      )}
    </Tile>
  );
}

/* ------------------------------------------------------------------ Gallery */

function GalleryTile({ cats, status, open }: { cats: GalleryCategory[] | null; status: GalleryStatus | null; open: () => void }) {
  if (!cats)
    return (
      <Tile title={t("dash.gallery")} className="c6">
        <Muted>{t("dash.loadingGallery")}</Muted>
        <Bar value={0} loading />
      </Tile>
    );
  const sets = cats.flatMap((c) => c.sets);
  // the Gallery's own Summary (what the overlay shows) wins; the sets read so far only when it isn't known yet
  const sum = status?.summary;
  const complete = sum?.sets?.[0] ?? sets.filter((s) => s.complete).length;
  const ofSets = sum?.sets?.[1] ?? sets.length;
  const score = sum?.score ?? sets.reduce((a, s) => a + s.score, 0);
  const collected = sets.reduce((a, s) => a + s.collected, 0);
  const total = sets.reduce((a, s) => a + s.total, 0);
  return (
    <Tile title={t("dash.gallery")} className="c6" action={<button className="dv-link" onClick={open}>{t("dash.openTracker")}</button>}>
      {sets.length === 0 || collected === 0 ? (
        <Muted>{t("dash.galleryEmpty")}</Muted>
      ) : (
        <>
          <span className="row base" style={{ gap: 8 }}>
            <Num value={complete} size="l" className="dv-big" />
            <span className="dv-muted dv-t18">{t("v2web.dash.ofSets", { n: fmt(ofSets) })}</span>
          </span>
          <Bar value={complete / Math.max(1, ofSets)} tone="ink" />
          <div className="row between">
            <span className="dv-muted">{sum?.level != null ? t("v2web.dash.level", { n: sum.level }) : t("dash.score")}</span>
            <span className="num dv-t20"><Gem /> {fmt(score)}</span>
          </div>
          {sum ? (
            <div className="row between dv-small dv-gal">
              {sum.s_ranks && (
                <span>
                  <b className="num">{sum.s_ranks[0]}</b> <Grade g="S" size="s" /> {t("v2web.dash.sRanks")}
                </span>
              )}
              {sum.first_owner != null && (
                <span>
                  <b className="num">{fmt(sum.first_owner)}</b> {t("v2web.dash.firstOwner")}
                </span>
              )}
              {sum.holographic != null && (
                <span>
                  <b className="num">{sum.holographic}</b> {t("v2web.dash.holo")}
                </span>
              )}
            </div>
          ) : (
            <div className="row between">
              <span className="dv-muted">{t("dash.cardsCollected")}</span>
              <span className="num dv-t20">{Math.round((collected / Math.max(1, total)) * 100)} %</span>
            </div>
          )}
        </>
      )}
    </Tile>
  );
}

/** the sets closest to their next grade (points to go), and the ones closest to complete (cards missing) */
function ClosestTile({ cats }: { cats: GalleryCategory[] | null }) {
  const sets = (cats ?? []).flatMap((c) => c.sets);
  const graded = sets.filter((s) => s.grade?.next && s.grade.points_to_next > 0).sort((a, b) => a.grade!.points_to_next - b.grade!.points_to_next).slice(0, 4);
  const open = sets.filter((s) => !s.complete && s.missing > 0).sort((a, b) => a.missing - b.missing).slice(0, Math.max(0, 4 - graded.length));
  if (!graded.length && !open.length) return null;
  return (
    <Tile title={t("v2web.dash.closest")} className="c6">
      <div className="list rule">
        {graded.map((s) => (
          <div key={s.key} className="lrow dv-row">
            <Grade g={s.grade!.grade} size="s" />
            <b className="strong ellip">{s.name} <ToGrade to={s.grade!.next!.grade} /></b>
            <span className="num dv-right dv-tok">
              {s.grade!.next!.tokens > 0 ? (
                <>
                  <GToken /> {s.grade!.next!.tokens} <small>{t("v2web.dash.tokensUnit")}</small>
                </>
              ) : null}
            </span>
            <span className="num dv-right">{t("v2web.dash.points", { n: fmt(s.grade!.points_to_next) })}</span>
          </div>
        ))}
        {open.map((s) => (
          <div key={s.key} className="lrow dv-row">
            <Grade g={null} size="s" />
            <b className="strong ellip">{s.name}</b>
            <span />
            <span className="num dv-right">{t("dash.missing", { count: s.missing })}</span>
          </div>
        ))}
      </div>
    </Tile>
  );
}

/* ------------------------------------------------------------------ objectives */

/** What you're playing (mockup 11): each planned session, its squad, the objectives it counts and the bonus ones. */
function SessionsTile({ view, open }: { view: SquadsView | null; open: () => void }) {
  const combos = view?.combos ?? [];
  return (
    <Tile title={t("v2web.dash.sessions")} className="c7" action={<button className="dv-link" onClick={open}>{view?.prefs.primary == null ? t("v2web.dash.auto") : t("dash.openTracker")}</button>}>
      {combos.length === 0 ? (
        <Muted>{view?.needs_sync ? t("dash.objectivesSync") : t("squads.none")}</Muted>
      ) : (
        <div className="list rule">
          {combos.slice(0, 6).map((c, i) => (
            <div key={c.id} className="lrow dv-row dv-ses">
              <span className="num dv-faint">{i + 1}</span>
              <div className="col" style={{ gap: 2, minWidth: 0 }}>
                <b className="strong ellip">{c.title || c.place_name}</b>
                <span className="dv-small ellip">
                  {c.squad ? (
                    <>
                      {c.squad.formation} · {t("v2web.dash.toBuy", { n: c.squad.buys })}
                      {c.squad.cost > 0 ? (
                        <>
                          {" "}
                          · <Coin /> {fmt(c.squad.cost)}
                        </>
                      ) : null}
                    </>
                  ) : (
                    t("v2web.dash.openInGame")
                  )}
                </span>
              </div>
              <span className="num dv-right dv-t20">{c.counted}</span>
              <span className="dv-small dv-right">{c.bonus ? t("v2web.dash.bonus", { n: c.bonus }) : ""}</span>
            </div>
          ))}
        </div>
      )}
      <SavedSquads limit={3} />
    </Tile>
  );
}

/* ------------------------------------------------------------------ buy next */

/** Best value (the overlay's Buy next): the cheapest grades to buy, tokens and coins, and all of them together. */
function BuyNextTile({ value, sets, open }: { value: BestValue | null; sets: GalleryCategory[] | null; open: () => void }) {
  const steps = value?.plan.steps ?? [];
  const grade = (key: string) => (sets ?? []).flatMap((c) => c.sets).find((x) => x.key === key)?.grade?.grade ?? null;
  return (
    <Tile title={t("v2web.dash.buyNext")} className="c6" action={steps.length ? <button className="dv-link" onClick={open}>{t("v2web.dash.allGrades", { n: steps.length })}</button> : undefined}>
      {!steps.length ? (
        <Muted>{t("v2web.dash.buyNone")}</Muted>
      ) : (
        <div className="list rule">
          {steps.slice(0, 4).map((st) => (
            <div key={st.key + st.grade} className="lrow dv-row dv-buy">
              <Grade g={grade(st.key)} size="s" />
              <b className="strong ellip">
                {st.name} <ToGrade to={st.grade} />
              </b>
              <span className="num dv-right dv-tok">
                <GToken /> {st.tokens} <small>{t("v2web.dash.tokensUnit")}</small>
              </span>
              <span className="row num dv-right" style={{ gap: 6, justifyContent: "flex-end" }}>
                <Coin /> {fmt(st.coins_needed)}
              </span>
            </div>
          ))}
          <div className="lrow dv-row dv-buy dv-sum">
            <span />
            <b className="strong">{t("v2web.dash.allRow", { n: steps.length, cards: value!.plan.players })}</b>
            <span className="num dv-right dv-tok">
              <GToken /> {value!.plan.tokens} <small>{t("v2web.dash.tokensUnit")}</small>
            </span>
            <span className="row num dv-right" style={{ gap: 6, justifyContent: "flex-end" }}>
              <Coin /> {fmt(value!.plan.coins_needed)}
            </span>
          </div>
        </div>
      )}
    </Tile>
  );
}

/* ------------------------------------------------------------------ sync and devices */

const PART_LABEL: Record<Part, Parameters<typeof t>[0]> = {
  gallery: "account.part.gallery",
  webapp: "account.part.webapp",
  champions: "account.part.champions",
  settings: "account.part.settings",
  saved: "account.part.saved",
};

/* mockup 11's Settings: the app's own settings as the account last synced them (part "settings"), read-only here –
   the switches live in the app and come back with its next sync. Tracking speed belongs to each PC (never synced). */
function SettingsTile({ view }: { view: SquadsView | null }) {
  const ui = appSettings();
  const onOff = (on: boolean | undefined) => (on == null ? null : <span className={`chip line ring ${on ? "done" : ""}`}>{t(on ? "settings.on" : "settings.off")}</span>);
  const chem = ui?.squads?.chem_mode ?? view?.prefs.chem_mode ?? null;
  const chemKey = chem === "30" || chem === "33" ? chem : "balanced";
  const rem = ui?.reminders;
  const at = rem?.at?.length ? rem.at.map((m) => (m === 0 ? t("settings.reminderLoad") : m === 45 ? t("settings.reminderHalf") : `${m}:00`)).join(" · ") : null;
  let lang: Locale | null = null;
  try {
    lang = (localStorage.getItem("fct.locale") as Locale | null) ?? getLocale();
  } catch {
    lang = getLocale();
  }
  return (
    <Tile title={t("v2web.dash.settings")} className="c5">
      <div className="list rule">
        <div className="lrow dv-row dv-set">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b className="strong">{t("settings.champions")}</b>
            <span className="dv-small">{t("v2web.dash.setChampions")}</span>
          </div>
          {onOff(ui?.champions) ?? <span className="dv-small">{t("v2web.dash.setUnknown")}</span>}
        </div>
        <div className="lrow dv-row dv-set">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b className="strong">{t("settings.reminders")}</b>
            <span className="dv-small">{at ?? t("v2web.dash.setReminders")}</span>
          </div>
          {onOff(rem?.on) ?? <span className="dv-small">{t("v2web.dash.setUnknown")}</span>}
        </div>
        <div className="lrow dv-row dv-set">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b className="strong">{t("speed.tab")}</b>
            <span className="dv-small">{t("v2web.dash.setSpeed")}</span>
          </div>
          <span />
        </div>
        <div className="lrow dv-row dv-set">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b className="strong">{t("v2web.dash.setChem")}</b>
            <span className="dv-small">{t(`squads.chemMode.${chemKey}Hint` as Parameters<typeof t>[0])}</span>
          </div>
          <span className="chip line ring">{t(`squads.chemMode.${chemKey}` as Parameters<typeof t>[0])}</span>
        </div>
        <div className="lrow dv-row dv-set">
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <b className="strong">{t("language")}</b>
            <span className="dv-small">{t("v2web.dash.setLanguage")}</span>
          </div>
          <span className="chip line ring">{lang && LOCALE_NAMES[lang] ? LOCALE_NAMES[lang] : "–"}</span>
        </div>
      </div>
      <span className="dv-small">{ui ? t("v2web.dash.setFromApp") : t("v2web.dash.setNotYet")}</span>
    </Tile>
  );
}

/** The account's signed-in devices (server data): this one, the app, the extension, other browsers. */
function DevicesTile({ devs, parts, open }: { devs: Device[] | null; parts: Record<string, CloudPart> | null; open: () => void }) {
  return (
    <Tile title={t("dash.devices")} className="c12" action={<button className="dv-link" onClick={open}>{t("menu.profile")}</button>}>
      <span className="dv-small">{t("v2web.dash.devicesText")}</span>
      <div className="row dv-parts">
        {(Object.keys(PART_LABEL) as Part[]).map((p) => {
          const info = parts?.[p];
          return (
            <span key={p} className="row dv-small" style={{ gap: 6 }} title={info ? t("dash.syncedFrom", { when: timeAgo(info.written_at ?? info.updated_at), device: info.device ?? t("account.conflict.otherDevice") }) : t("dash.notSynced")}>
              <Dot tone={info ? "done" : undefined} />
              <b className="strong">{t(PART_LABEL[p])}</b> {info ? timeAgo(info.written_at ?? info.updated_at) : t("dash.notSynced")}
            </span>
          );
        })}
      </div>
      <div>
        {devs && devs.length > 0 && (
          <div className="dv-devs">
            {devs.map((d) => (
              <div key={d.id} className="block cut dv-dev">
                <span className="eyebrow">{d.this ? t("account.thisDevice") : t("v2web.dash.device")}</span>
                <b className="strong">{d.name}</b>
                {d.version && <span className="num dv-small">{t("v2web.dash.version", { v: d.version })}</span>}
                <span className="dv-small row" style={{ gap: 6 }}>
                  {d.this && <Dot tone="done" />}
                  {d.this ? t("v2web.dash.online") : formatAge(Date.parse(d.last_seen))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Tile>
  );
}

/* ------------------------------------------------------------------ page */

function SignedOut() {
  return (
    <main className="dv-wrap dv-signin">
      <span className="eyebrow accent">{t("dash.title")}</span>
      <h1 className="dv-h1">{t("v2web.dash.signInTitle")}</h1>
      <p className="dv-lead">{t("dash.signInText")}</p>
      {handoffState() === "failed" && <p className="dv-notice warn" role="status">{t("v2web.handoff.failed")}</p>}
      <Panel cut="xl" className="acct-dialog dv-card">
        <Account />
      </Panel>
    </main>
  );
}

export default function Dashboard() {
  useLocale();
  const [theme, setTheme] = useTheme();
  const acc = useAccount();
  // one page per address (#club, #gallery …); the old #tracker opens the Gallery
  const read = (): Route => {
    const h = location.hash.slice(1);
    return h === "tracker" ? "gallery" : (ROUTES as string[]).includes(h) ? (h as Route) : "home";
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (r: Route) => {
    history.pushState(null, "", r === "home" ? location.pathname + location.search : `#${r}`);
    setRoute(r);
    window.scrollTo(0, 0);
  };
  const data = useData();
  const u = acc.user;

  if (acc.status !== "in") {
    return (
      <div className="dv">
        <SiteHeader signedIn={false} name={null} onAccount={() => {}} theme={theme} setTheme={setTheme} />
        {acc.status === "loading" ? (
          <main className="dv-wrap">
            <p className="dv-muted dv-loading">{t(handoffState() === "redeeming" ? "v2web.handoff.signingIn" : "account.loading")}</p>
            <Bar value={0} loading />
          </main>
        ) : (
          <SignedOut />
        )}
        <SiteFooter theme={theme} setTheme={setTheme} />
      </div>
    );
  }

  return (
    <Shell route={route} go={go} theme={theme} setTheme={setTheme} syncedAt={acc.sync.at ? t("dash2.accountUpToDate", { when: timeAgo(acc.sync.at) }) : null}>
      <SyncConflict />
      {route === "club" ? (
        <ClubPage view={data.squads} />
      ) : route === "objectives" ? (
        <ObjectivesPage key="objectives" view={data.squads} />
      ) : route === "creator" ? (
        <CreatorPage view={data.squads} champs={data.champs} status={data.status} cats={data.gallery} />
      ) : route === "profile" ? (
        <main className="dv-wrap dv-narrow">
          <Panel cut="xl" className="acct-dialog dv-card">
            <Account />
          </Panel>
        </main>
      ) : route !== "home" ? (
        <OverlayPage key={route} route={route} />
      ) : (
        <main className="dv-wrap dv-wide">
          <Head eyebrow={t("dash.title")} title={t("v2web.dash.yours")}>
            {MOCK && <Chip tone="warn">{t("v2web.dash.mock")}</Chip>}
            {!u?.username && (
              <button className="btn btn-primary btn-s" onClick={() => go("profile")}>
                {t("profile.create")}
              </button>
            )}
          </Head>
          <div className="dv-grid">
            <ChampionsHero data={data.champs} open={() => go("champions")} />
            <ClubTile view={data.squads} />
            <GalleryTile cats={data.gallery} status={data.status} open={() => go("gallery")} />
            <SessionsTile view={data.squads} open={() => go("objectives")} />
            <SettingsTile view={data.squads} />
            <BuyNextTile value={data.value} sets={data.gallery} open={() => go("value")} />
            <ClosestTile cats={data.gallery} />
            <DevicesTile devs={data.devs} parts={data.parts} open={() => go("profile")} />
          </div>
        </main>
      )}
    </Shell>
  );
}
