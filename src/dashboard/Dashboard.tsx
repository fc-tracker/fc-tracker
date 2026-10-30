/**
 * The dashboard: a full overview of everything the account holds – the Gallery (sets, score),
 * Champions weekends, objective squads (and the ones saved to build later), devices and sync –
 * plus the whole tracker and the profile. Signed out it is a sign-in page. Every number comes
 * from the same model as the app (the account's synced data, computed here).
 */
import { useEffect, useState } from "react";
import { api, formatAge, type GalleryCategory } from "../api";
import { num } from "../format";
import { t, useLocale } from "../i18n";
import { useTheme } from "../theme";
import Overlay from "../Overlay";
import OverlayMenu, { Avatar } from "../OverlayMenu";
import SyncConflict, { timeAgo } from "../SyncConflict";
import { Account } from "../AccountSettings";
import { SavedSquads } from "../Squads";
import { devices, syncedParts, useAccount, type CloudPart, type Device, type Part } from "../account";
import type { ChampsData } from "../championsData";
import type { SquadsView } from "../squadsData";

type Tab = "overview" | "tracker" | "profile";

function useData() {
  const acc = useAccount();
  const [gallery, setGallery] = useState<GalleryCategory[] | null>(null);
  const [champs, setChamps] = useState<ChampsData | null>(null);
  const [squads, setSquads] = useState<SquadsView | null>(null);
  const [parts, setParts] = useState<Record<string, CloudPart> | null>(null);
  const [devs, setDevs] = useState<Device[] | null>(null);
  // every sync may bring new data: read it all again
  useEffect(() => {
    if (acc.status !== "in" || acc.sync.phase === "syncing") return;
    api.galleryOverview().then(setGallery).catch(() => setGallery([]));
    api.championsData().then(setChamps).catch(() => setChamps(null));
    api.squadsPlan().then(setSquads).catch(() => setSquads(null));
    syncedParts().then(setParts).catch(() => setParts({}));
    devices().then(setDevs).catch(() => setDevs([]));
  }, [acc.status, acc.sync.at, acc.sync.phase]);
  useEffect(() => {
    const on = () => api.championsData().then(setChamps).catch(() => {});
    window.addEventListener("fct-web-champions", on);
    return () => window.removeEventListener("fct-web-champions", on);
  }, []);
  return { gallery, champs, squads, parts, devs };
}

function Tile({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="dash-tile">
      <header>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="dash-stat">
      <b>{value}</b>
      <small>{label}</small>
    </div>
  );
}

function GalleryTile({ cats, open }: { cats: GalleryCategory[] | null; open: () => void }) {
  if (!cats) return <Tile title={t("dash.gallery")}><p className="dash-muted">{t("dash.loadingGallery")}</p></Tile>;
  const sets = cats.flatMap((c) => c.sets);
  const complete = sets.filter((s) => s.complete).length;
  const score = sets.reduce((a, s) => a + s.score, 0);
  const collected = sets.reduce((a, s) => a + s.collected, 0);
  const total = sets.reduce((a, s) => a + s.total, 0);
  const closest = sets.filter((s) => !s.complete && s.missing > 0).sort((a, b) => a.missing - b.missing).slice(0, 4);
  return (
    <Tile title={t("dash.gallery")} action={<button className="dash-link" onClick={open}>{t("dash.openTracker")}</button>}>
      {sets.length === 0 || collected === 0 ? (
        <p className="dash-muted">{t("dash.galleryEmpty")}</p>
      ) : (
        <>
          <div className="dash-stats">
            <Stat value={num(score)} label={t("dash.score")} />
            <Stat value={`${complete}/${sets.length}`} label={t("dash.setsComplete")} />
            <Stat value={`${Math.round((collected / Math.max(1, total)) * 100)} %`} label={t("dash.cardsCollected")} />
          </div>
          {closest.length > 0 && (
            <>
              <h3 className="dash-sub">{t("dash.closest")}</h3>
              <ul className="dash-list">
                {closest.map((s) => (
                  <li key={s.key}>
                    <span>{s.name}</span>
                    <small>{t("dash.missing", { count: s.missing })}</small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Tile>
  );
}

function ChampionsTile({ data, open }: { data: ChampsData | null; open: () => void }) {
  const runs = (data?.runs ?? []).filter((r) => r.matches.length > 0 || r.hub.wins + r.hub.losses > 0);
  const best = runs.reduce<(typeof runs)[number] | null>((b, r) => (!b || r.hub.wins > b.hub.wins ? r : b), null);
  const wins = runs.reduce((a, r) => a + r.hub.wins, 0);
  const losses = runs.reduce((a, r) => a + r.hub.losses, 0);
  return (
    <Tile title={t("dash.champions")} action={<button className="dash-link" onClick={open}>{t("dash.openTracker")}</button>}>
      {runs.length === 0 ? (
        <p className="dash-muted">{t("dash.championsEmpty")}</p>
      ) : (
        <>
          <div className="dash-stats">
            <Stat value={String(runs.length)} label={t("dash.weekends")} />
            <Stat value={`${wins}–${losses}`} label={t("dash.record")} />
            {best && <Stat value={`${best.hub.wins}–${best.hub.losses}`} label={t("dash.bestWeekend")} />}
          </div>
          <ul className="dash-list">
            {[...runs].reverse().slice(0, 5).map((r) => (
              <li key={r.id}>
                <span>{r.ends_at ? new Date(r.ends_at).toLocaleDateString() : "–"}</span>
                <small>
                  {r.hub.wins}–{r.hub.losses}
                  {r.hub.rank ? ` · ${r.hub.rank}` : ""}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}
    </Tile>
  );
}

function ObjectivesTile({ view, open }: { view: SquadsView | null; open: () => void }) {
  const events = view?.events ?? [];
  return (
    <Tile title={t("dash.objectives")} action={<button className="dash-link" onClick={open}>{t("dash.openTracker")}</button>}>
      {events.length === 0 ? (
        <p className="dash-muted">{view?.needs_sync ? t("dash.objectivesSync") : t("squads.none")}</p>
      ) : (
        <ul className="dash-list">
          {events.slice(0, 6).map((e) => (
            <li key={e.id}>
              <span>{e.title}</span>
              <small>
                {t("squads.done", { done: e.done, total: e.total })}
                {e.squad ? ` · ${e.squad.met}/${e.reqs.length} ${t("squads.reqsMet")}` : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
      <SavedSquads limit={3} />
    </Tile>
  );
}

const PART_LABEL: Record<Part, Parameters<typeof t>[0]> = {
  gallery: "account.part.gallery",
  webapp: "account.part.webapp",
  champions: "account.part.champions",
  settings: "account.part.settings",
  saved: "account.part.saved",
};

function SyncTile({ parts, devs, open }: { parts: Record<string, CloudPart> | null; devs: Device[] | null; open: () => void }) {
  return (
    <Tile title={t("dash.devices")} action={<button className="dash-link" onClick={open}>{t("menu.profile")}</button>}>
      <ul className="dash-list">
        {(Object.keys(PART_LABEL) as Part[]).map((p) => {
          const info = parts?.[p];
          return (
            <li key={p}>
              <span>{t(PART_LABEL[p])}</span>
              <small>{info ? t("dash.syncedFrom", { when: timeAgo(info.written_at ?? info.updated_at), device: info.device ?? t("account.conflict.otherDevice") }) : t("dash.notSynced")}</small>
            </li>
          );
        })}
      </ul>
      {devs && devs.length > 0 && (
        <>
          <h3 className="dash-sub">{t("account.devices")}</h3>
          <ul className="dash-list">
            {devs.map((d) => (
              <li key={d.id}>
                <span>{d.name}</span>
                <small>{d.this ? t("account.thisDevice") : formatAge(Date.parse(d.last_seen))}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </Tile>
  );
}

function SignedOut() {
  return (
    <main className="dash-signin">
      <h1>{t("dash.title")}</h1>
      <p>{t("dash.signInText")}</p>
      <section className="acct-dialog dash-card">
        <Account />
      </section>
    </main>
  );
}

export default function Dashboard() {
  useLocale();
  const [theme, setTheme] = useTheme();
  const acc = useAccount();
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "overview");
  const data = useData();
  useEffect(() => {
    history.replaceState(null, "", tab === "overview" ? location.pathname + location.search : `#${tab}`);
  }, [tab]);
  const u = acc.user;

  return (
    <div className="dash">
      <header className="dash-bar">
        <a className="wb-brand" href="/" aria-label="FC-Tracker">
          <span className="brand-mark" aria-hidden="true" />
          <span className="wb-brand-name">FC-Tracker</span>
        </a>
        {acc.status === "in" && (
          <nav className="dash-tabs" aria-label={t("dash.title")}>
            {(["overview", "tracker", "profile"] as const).map((k) => (
              <button key={k} className={tab === k ? "on" : ""} aria-pressed={tab === k} onClick={() => setTab(k)}>
                {t(`dash.tab.${k}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </nav>
        )}
        <div className="dash-actions">
          <a className="wb-btn ghost" href="/web">
            {t("dash.useTracker")}
          </a>
          <OverlayMenu theme={theme} setTheme={setTheme} zoom={1} setZoom={() => {}} />
        </div>
      </header>
      <SyncConflict />

      {acc.status === "loading" ? (
        <p className="dash-muted dash-pad">{t("account.loading")}</p>
      ) : acc.status === "out" ? (
        <SignedOut />
      ) : tab === "tracker" ? (
        <div className="dash-tracker">
          <Overlay />
        </div>
      ) : tab === "profile" ? (
        <main className="dash-pad dash-narrow">
          <section className="acct-dialog dash-card">
            <Account />
          </section>
        </main>
      ) : (
        <main className="dash-pad">
          <section className="dash-hero">
            <Avatar size={72} />
            <div>
              <h1>
                {u?.display_name ?? t("account.noName")}
                {u?.verified && <span className="me-verified" title={t("profile.verified")} aria-label={t("profile.verified")} />}
              </h1>
              <p className="dash-muted">
                {u?.email}
                {u?.created_at && <> · {t("dash.memberSince", { date: new Date(u.created_at).toLocaleDateString() })}</>}
                {acc.sync.at && <> · {t("account.synced", { when: timeAgo(acc.sync.at) })}</>}
              </p>
            </div>
            {!u?.username && (
              <button className="wb-btn" onClick={() => setTab("profile")}>
                {t("profile.create")}
              </button>
            )}
          </section>
          <div className="dash-grid">
            <GalleryTile cats={data.gallery} open={() => setTab("tracker")} />
            <ChampionsTile data={data.champs} open={() => setTab("tracker")} />
            <ObjectivesTile view={data.squads} open={() => setTab("tracker")} />
            <SyncTile parts={data.parts} devs={data.devs} open={() => setTab("profile")} />
          </div>
        </main>
      )}
    </div>
  );
}
