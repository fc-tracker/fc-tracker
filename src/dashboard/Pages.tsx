/**
 * The dashboard as its own app (dashboard.fc-tracker.com, user 2026-11-05: "a detached part, not something the app
 * opens"): a left rail with every page, the account's data on each. Gallery, Best value, Planner, Objectives and
 * Champions are the overlay's own views (the same components as the app and FC-Tracker Web – one look everywhere);
 * Club is every player as an EA card; Share links publish an objective squad read-only; Creator makes images of the
 * player's own data with the FC-Tracker mark. Nothing here invents a number: it is all the synced data.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import { THEMES, type Theme } from "../theme";
import Overlay from "../Overlay";
import { Avatar } from "../OverlayMenu";
import { createShare, deleteShare, myShares, shareUrl, useAccount, type ShareInfo } from "../account";
import { weekendLabel } from "../Champions";
import { RANKS, rankFor, weekendStats, type ChampsData, type ChampsRun } from "../championsData";
import type { ClubEntry, SessionPlan, SquadsView } from "../squadsData";
import { Pitch } from "../share/Pitch";
import { matches } from "../search";
import { sharePayload } from "../share/payload";
import { clubCard } from "../launcher/cards";
import { Bar, Chip, Dot, FutCard, Gem, Grade, Mark, Panel, Score, Ticks, fmt } from "../ui";
import type { GalleryCategory, GalleryStatus } from "../api";

export type Route = "home" | "club" | "gallery" | "value" | "planner" | "objectives" | "champions" | "creator" | "profile";
export const ROUTES: Route[] = ["home", "club", "gallery", "value", "planner", "objectives", "champions", "creator", "profile"];
const SECTION: Partial<Record<Route, string>> = { gallery: "sets", value: "value", planner: "planner", objectives: "squads", champions: "champions" };
type Key = Parameters<typeof t>[0];
const NAV: Record<Route, Key> = {
  home: "dash2.nav.home",
  club: "dash2.nav.club",
  gallery: "dash2.nav.gallery",
  value: "dash2.nav.value",
  planner: "dash2.nav.planner",
  objectives: "dash2.nav.objectives",
  champions: "dash2.nav.champions",
  creator: "dash2.nav.creator",
  profile: "dash2.nav.profile",
};
/** sub-pages sit indented under their page in the rail */
const SUB = new Set<Route>(["value", "planner"]);

/* ------------------------------------------------------------------ the shell */

export function Shell({ route, go, theme, setTheme, syncedAt, children }: { route: Route; go: (r: Route) => void; theme: Theme; setTheme: (t: Theme) => void; syncedAt: string | null; children: React.ReactNode }) {
  const acc = useAccount();
  const u = acc.user;
  return (
    <div className={`dvs ${SECTION[route] ? "is-embed" : ""}`}>
      <aside className="dvs-rail">
        <a className="dvs-brand" href={location.hostname === "dashboard.fc-tracker.com" ? "https://www.fc-tracker.com/" : "/"}>
          <Mark />
          <span>FC-Tracker</span>
        </a>
        <nav className="dvs-nav" aria-label={t("dash.title")}>
          {ROUTES.filter((r) => r !== "profile").map((r) => (
            <button key={r} type="button" className={`dvs-item ${SUB.has(r) ? "sub" : ""} ${route === r ? "on" : ""}`} aria-current={route === r ? "page" : undefined} onClick={() => go(r)}>
              {t(NAV[r])}
            </button>
          ))}
        </nav>
        <div className="dvs-foot">
          {syncedAt && (
            <span className="row dv-small" style={{ gap: 8 }}>
              <Dot tone="done" />
              {syncedAt}
            </span>
          )}
          <div className="seg dvs-theme" role="group" aria-label={t("overlay.theme")}>
            {THEMES.map((th) => (
              <button key={th} type="button" aria-pressed={theme === th} onClick={() => setTheme(th)}>
                {t(`theme.${th}` as Key)}
              </button>
            ))}
          </div>
          <button type="button" className={`dvs-me ${route === "profile" ? "on" : ""}`} onClick={() => go("profile")}>
            <Avatar size={28} />
            <span className="ellip">{u?.display_name ?? t("dash2.nav.profile")}</span>
          </button>
        </div>
      </aside>
      <div className="dvs-main">{children}</div>
    </div>
  );
}

/** Page head: eyebrow, title, a line, actions right. */
export function Head({ eyebrow, title, text, children }: { eyebrow?: string; title: string; text?: string; children?: React.ReactNode }) {
  return (
    <div className="dv-head">
      <div className="col" style={{ gap: 10, minWidth: 0 }}>
        {eyebrow && <span className="eyebrow accent">{eyebrow}</span>}
        <h1 className="dv-h1 dv-title">{title}</h1>
        {text && <p className="dv-muted">{text}</p>}
      </div>
      {children && <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ the overlay's own views */

/** Gallery, Best value, Planner, Objectives, Champions: the overlay itself at that section (it reads the section
 *  from the address once – the key remounts it per page), without its header (the rail is the menu). */
export function OverlayPage({ route }: { route: Route }) {
  const section = SECTION[route]!;
  useState(() => {
    const u = new URL(location.href);
    u.searchParams.set("section", section);
    history.replaceState(null, "", u.pathname + u.search + location.hash);
    return true;
  });
  return (
    <div className="dv-embed">
      <Overlay />
    </div>
  );
}

/* ------------------------------------------------------------------ Club: every player */

const GROUPS: { id: string; label: Key; pos: string[] }[] = [
  { id: "all", label: "dash2.club.all", pos: [] },
  { id: "gk", label: "dash2.club.gk", pos: ["GK"] },
  { id: "def", label: "dash2.club.def", pos: ["CB", "LB", "RB", "LWB", "RWB"] },
  { id: "mid", label: "dash2.club.mid", pos: ["CDM", "CM", "CAM", "LM", "RM"] },
  { id: "att", label: "dash2.club.att", pos: ["ST", "CF", "LW", "RW"] },
];
type Sort = "meta" | "rating" | "name";
const bestMeta = (c: ClubEntry) => (c.meta ? Math.max(...Object.values(c.meta)) : c.rating);

export function ClubPage({ view }: { view: SquadsView | null }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("all");
  const [sort, setSort] = useState<Sort>("meta");
  const club = useMemo(() => (view?.club ?? []).filter((c) => c.owned), [view]);
  const list = useMemo(() => {
    const g = GROUPS.find((x) => x.id === group)!;
    return club
      .filter((c) => (!g.pos.length || c.positions.some((p) => g.pos.includes(p))) && (!q.trim() || matches(c.name, q)))
      .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "rating" ? b.rating - a.rating || bestMeta(b) - bestMeta(a) : bestMeta(b) - bestMeta(a)));
  }, [club, q, group, sort]);
  return (
    <main className="dv-wrap dv-wide">
      <Head eyebrow={t("dash2.nav.club")} title={t("dash2.club.title")} text={view ? t("dash2.club.count", { count: club.length }) : undefined} />
      <div className="dvc-tools">
        <input className="dvc-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("dash2.club.search")} aria-label={t("dash2.club.search")} />
        <div className="seg" role="group" aria-label={t("dash2.club.position")}>
          {GROUPS.map((g) => (
            <button key={g.id} type="button" aria-pressed={group === g.id} onClick={() => setGroup(g.id)}>
              {t(g.label)}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t("dash2.club.sort")}>
          {(["meta", "rating", "name"] as const).map((s) => (
            <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)}>
              {t(`dash2.club.sort.${s}` as Key)}
            </button>
          ))}
        </div>
      </div>
      {!view ? (
        <div className="col" style={{ gap: 10 }}>
          <p className="dv-muted">{t("dash2.club.loading")}</p>
          <Bar value={0} loading />
        </div>
      ) : club.length === 0 ? (
        <p className="dv-muted">{t("dash2.club.empty")}</p>
      ) : list.length === 0 ? (
        <p className="dv-muted">{t("dash2.club.none")}</p>
      ) : (
        <div className="dvc-grid">
          {list.map((c) => {
            const pos = c.positions[0];
            return (
              <figure key={c.key} className="dvc-card">
                <FutCard card={{ ...clubCard(c, pos), meta: c.meta?.[pos] ?? null }} size="small" w={132} />
                <figcaption className="num">
                  <Gem />
                  {bestMeta(c).toFixed(1)}
                  {c.loan && <Chip tone="line">{t("squads.loan")}</Chip>}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ Share links (objective squads) */

export function SharesPanel({ view }: { view: SquadsView | null }) {
  const [mine, setMine] = useState<ShareInfo[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const load = () => myShares().then(setMine).catch(() => setMine([]));
  useEffect(() => void load(), []);
  const sessions = (view?.combos ?? []).filter((s) => s.squad);
  const make = async (s: SessionPlan) => {
    const p = sharePayload(s);
    if (!p) return;
    setBusy(s.id);
    setErr(false);
    try {
      const id = await createShare(p);
      await copy(id);
      await load();
    } catch {
      setErr(true);
    } finally {
      setBusy(null);
    }
  };
  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(shareUrl(id));
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2500);
    } catch {}
  };
  return (
    <Panel className="dv-tile dvsh">
      <div className="dv-tile-h">
        <span className="eyebrow">{t("dash2.share.title")}</span>
      </div>
      <p className="dv-muted">{t("dash2.share.text")}</p>
      {sessions.length === 0 ? (
        <p className="dv-muted">{t("dash2.creator.noXi")}</p>
      ) : (
        <div className="list rule">
          {sessions.slice(0, 6).map((s) => (
            <div key={s.id} className="lrow dvsh-row">
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <b className="strong ellip">{s.title}</b>
                <span className="dv-small">{t("lh.obj.count", { count: s.counted }).replace(/.$/, "")} · {s.squad!.formation}</span>
              </span>
              <button type="button" className="btn btn-secondary ring btn-s" disabled={busy != null} onClick={() => void make(s)}>
                {busy === s.id ? t("dash2.share.making") : t("dash2.share.make")}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <p className="dv-notice warn" role="status">{t("dash2.share.error")}</p>}
      <span className="eyebrow" style={{ marginTop: 8 }}>{t("dash2.share.mine")}</span>
      {mine == null ? (
        <p className="dv-muted">{t("dash2.share.loading")}</p>
      ) : mine.length === 0 ? (
        <p className="dv-muted">{t("dash2.share.none")}</p>
      ) : (
        <div className="list rule">
          {mine.map((m) => (
            <div key={m.id} className="lrow dvsh-row">
              <span className="col" style={{ gap: 2, minWidth: 0 }}>
                <a className="strong ellip" href={shareUrl(m.id)} target="_blank" rel="noopener">{m.title ?? m.id}</a>
                <span className="dv-small">{t("dash2.share.views", { count: m.views })}</span>
              </span>
              <span className="row" style={{ gap: 8 }}>
                <button type="button" className="btn btn-quiet btn-s" onClick={() => void copy(m.id)}>
                  {copied === m.id ? t("dash2.share.copied") : t("dash2.share.copy")}
                </button>
                <button type="button" className="btn btn-quiet btn-s" onClick={() => void deleteShare(m.id).then(load).catch(() => setErr(true))}>
                  {t("dash2.share.delete")}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/** The objectives page: share links on top, the overlay's Objectives under them. */
export function ObjectivesPage({ view }: { view: SquadsView | null }) {
  return (
    <>
      <div className="dv-wrap dv-wide dv-tight">
        <SharesPanel view={view} />
      </div>
      <OverlayPage route="objectives" />
    </>
  );
}

/* ------------------------------------------------------------------ Creator: images of the player's own data */

type Template = "champions" | "xi" | "gallery";
type Format = "post" | "story";
const SIZE: Record<Format, [number, number]> = { post: [1080, 1350], story: [1080, 1920] };
const EA = "https://www.ea.com/ea-sports-fc/ultimate-team/web-app/";

/** The month with the latest tracked weekend: its weekends, oldest first. */
function lastMonth(data: ChampsData | null): { label: string; runs: ChampsRun[] } | null {
  const runs = (data?.runs ?? []).filter((r) => r.matches.length || r.hub.wins + r.hub.losses > 0);
  if (!runs.length) return null;
  const at = (r: ChampsRun) => r.ends_at ?? r.hub.ends_at ?? r.id;
  const last = new Date(Math.max(...runs.map(at)));
  const same = runs.filter((r) => {
    const d = new Date(at(r));
    return d.getMonth() === last.getMonth() && d.getFullYear() === last.getFullYear();
  });
  return { label: last.toLocaleDateString(undefined, { month: "long", year: "numeric" }), runs: same.sort((a, b) => at(a) - at(b)) };
}
const record = (r: ChampsRun): [number, number] => {
  const s = weekendStats(r);
  return [Math.max(r.hub.wins, s.wins), Math.max(r.hub.losses, s.losses)];
};

function Watermark() {
  return (
    <div className="cr-mark">
      <Mark />
      <span>
        <b>{t("dash2.creator.made")}</b>
        <small>fc-tracker.com</small>
      </span>
    </div>
  );
}

function ChampionsArt({ data, name }: { data: ChampsData | null; name: string | null }) {
  const m = lastMonth(data);
  if (!m) return <p className="cr-empty">{t("dash2.creator.noChamps")}</p>;
  const recs = m.runs.map(record);
  const wins = recs.reduce((a, r) => a + r[0], 0);
  const losses = recs.reduce((a, r) => a + r[1], 0);
  const best = Math.max(...recs.map((r) => r[0]));
  // the player's own numbers over the month (never an opponent)
  const stats = m.runs.map(weekendStats).reduce((x, y) => ({ played: x.played + y.played, goalsFor: x.goalsFor + y.goalsFor, goalsAgainst: x.goalsAgainst + y.goalsAgainst, comebacks: x.comebacks + y.comebacks }), { played: 0, goalsFor: 0, goalsAgainst: 0, comebacks: 0 });
  return (
    <div className="cr-body">
      <span className="cr-eyebrow">{t("dash2.creator.month", { month: m.label })}</span>
      <h2 className="cr-h">{name ? t("dash2.creator.whose", { name }) : t("dash2.creator.champions")}</h2>
      <div className="cr-hero">
        <Score a={wins} b={losses} />
        <span className="cr-sub">{t("dash2.creator.weekends", { count: m.runs.length })}</span>
      </div>
      <div className="cr-list">
        {m.runs.map((r, i) => {
          const [w, l] = recs[i];
          return (
            <div key={r.id} className="cr-row">
              <span className="col" style={{ gap: 14 }}>
                <span>{weekendLabel(r)}</span>
                <Ticks items={weekendStats(r).form.map((o) => (o === "win" ? "w" : "l"))} />
              </span>
              <span className="cr-rank">{rankFor(w) ?? ""}</span>
              <b className="num">{w}–{l}</b>
            </div>
          );
        })}
      </div>
      <div className="cr-stats">
        <span>
          <b className="num">{stats.played}</b>
          <small>{t("dash2.creator.matches")}</small>
        </span>
        {/* goals only when the scores were read (never a made-up 0–0) */}
        {stats.goalsFor + stats.goalsAgainst > 0 && (
          <span>
            <b className="num">
              <Score a={stats.goalsFor} b={stats.goalsAgainst} />
            </b>
            <small>{t("dash2.creator.goals")}</small>
          </span>
        )}
        <span>
          <b className="num">{stats.comebacks}</b>
          <small>{t("dash2.creator.comebacks")}</small>
        </span>
      </div>
      <div className="cr-foot">
        <span className="cr-sub">{t("dash2.creator.best")}</span>
        <b>{best > 0 ? RANKS[best - 1] : "–"}</b>
      </div>
    </div>
  );
}

function XiArt({ view, story }: { view: SquadsView | null; story: boolean }) {
  const s = (view?.combos ?? []).find((x) => x.squad);
  if (!s?.squad) return <p className="cr-empty">{t("dash2.creator.noXi")}</p>;
  return (
    <div className="cr-body">
      <span className="cr-eyebrow">{s.place_name}</span>
      <h2 className="cr-h">
        {t("lh.obj.xi")} {t("lh.obj.count", { count: s.counted })}
      </h2>
      <span className="cr-sub">
        {s.squad.formation} · {t("lh.obj.chem", { count: s.squad.chem })}
      </span>
      {/* five lines of cards fit above the mark: smaller cards in the 4:5 post */}
      <Pitch slots={sharePayload(s)!.slots} w={story ? 150 : 88} />
    </div>
  );
}

function GalleryArt({ status, cats }: { status: GalleryStatus | null; cats: GalleryCategory[] | null }) {
  const sum = status?.summary;
  const sets = (cats ?? []).flatMap((c) => c.sets).filter((x) => x.grade?.grade);
  const order = "SABCD";
  const top = [...sets].sort((a, b) => order.indexOf(a.grade!.grade ?? "") - order.indexOf(b.grade!.grade ?? "") || b.score - a.score).slice(0, 6);
  if (!sum?.score && !top.length) return <p className="cr-empty">{t("dash2.creator.noGallery")}</p>;
  return (
    <div className="cr-body">
      <span className="cr-eyebrow">{t("dash2.creator.galleryEyebrow")}</span>
      <h2 className="cr-h">{t("dash2.creator.gallery")}</h2>
      <div className="cr-hero">
        <span className="cr-big num">
          <Gem />
          {fmt(sum?.score ?? top.reduce((a, x) => a + x.score, 0))}
        </span>
        {sum?.sets && <span className="cr-sub">{t("dash2.creator.sets", { done: sum.sets[0], total: sum.sets[1] })}</span>}
      </div>
      <div className="cr-list">
        {top.map((x) => (
          <div key={x.key} className="cr-row">
            <span className="ellip">{x.name}</span>
            <Grade g={x.grade!.grade} size="s" />
            <b className="num">{fmt(x.score)}</b>
          </div>
        ))}
      </div>
      {sum?.first_owner != null && (
        <div className="cr-foot">
          <span className="cr-sub">{t("ui.firstOwner")}</span>
          <b className="num">{fmt(sum.first_owner)}</b>
        </div>
      )}
    </div>
  );
}

export function CreatorPage({ view, champs, status, cats }: { view: SquadsView | null; champs: ChampsData | null; status: GalleryStatus | null; cats: GalleryCategory[] | null }) {
  const acc = useAccount();
  const [tpl, setTpl] = useState<Template>("champions");
  const [fmtx, setFmt] = useState<Format>("post");
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const art = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const [w, h] = SIZE[fmtx];
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // the preview fits the page in width and height (a 9:16 story never runs off the screen)
    const fit = () => setScale(Math.min(1, el.clientWidth / w, (window.innerHeight * 0.72) / h));
    const ro = new ResizeObserver(fit);
    window.addEventListener("resize", fit);
    fit();
    ro.observe(el);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [w, h]);
  const download = async () => {
    const node = art.current;
    if (!node) return;
    setState("busy");
    try {
      // EA's art goes through our own address (/ea-img → EA's CDN) so the picture may be read back – EA's CDN
      // sends no CORS headers
      const imgs = [...node.querySelectorAll("img")];
      await Promise.all(
        imgs.map((img) => {
          if (!img.src.startsWith(EA)) return Promise.resolve();
          img.crossOrigin = "anonymous";
          img.src = "/ea-img/" + img.src.slice(EA.length);
          return img.decode().catch(() => {});
        }),
      );
      const { toPng } = await import("html-to-image");
      const url = await toPng(node, { width: w, height: h, pixelRatio: 1, style: { transform: "none" }, cacheBust: false });
      const a = document.createElement("a");
      a.href = url;
      a.download = `fc-tracker-${tpl}-${fmtx}.png`;
      a.click();
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  const name = acc.user?.display_name ?? null;
  return (
    <main className="dv-wrap dv-wide">
      <Head eyebrow={t("dash2.nav.creator")} title={t("dash2.creator.title")} text={t("dash2.creator.text")}>
        <button type="button" className="btn btn-primary btn-s" disabled={state === "busy"} onClick={() => void download()}>
          {state === "busy" ? t("dash2.creator.making") : t("dash2.creator.download")}
        </button>
      </Head>
      <div className="dvc-tools">
        <div className="seg" role="group" aria-label={t("dash2.creator.template")}>
          {(["champions", "xi", "gallery"] as const).map((x) => (
            <button key={x} type="button" aria-pressed={tpl === x} onClick={() => setTpl(x)}>
              {t(`dash2.creator.tpl.${x}` as Key)}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label={t("dash2.creator.format")}>
          {(["post", "story"] as const).map((x) => (
            <button key={x} type="button" aria-pressed={fmtx === x} onClick={() => setFmt(x)}>
              {t(`dash2.creator.fmt.${x}` as Key)}
            </button>
          ))}
        </div>
      </div>
      {state === "failed" && <p className="dv-notice warn" role="status">{t("dash2.creator.failed")}</p>}
      <div className="cr-stage" ref={box} style={{ height: h * scale }}>
        <div className="cr-frame" style={{ width: w * scale, height: h * scale }}>
        <div className="cr-art" ref={art} data-fmt={fmtx} style={{ width: w, height: h, transform: `scale(${scale})` }}>
          {tpl === "champions" ? <ChampionsArt data={champs} name={name} /> : tpl === "xi" ? <XiArt view={view} story={fmtx === "story"} /> : <GalleryArt status={status} cats={cats} />}
          <Watermark />
        </div>
        </div>
      </div>
    </main>
  );
}
