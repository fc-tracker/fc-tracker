// A shared objective squad (fc-tracker.com/s/<id>, user 2026-11-05): the public, read-only copy a player made on the
// dashboard – the XI, its formation and the objectives it clears. No coins, prices or item ids exist in it (the server
// strips them). Built with FC-Tracker Web (`npm run build:web`, entry share.html).
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { LOCALES, setLocale, t, useLocale, type Locale } from "../i18n";
import { useTheme } from "../theme";
import { getShare, type SharedSquad } from "../account";
import { Bar, Mark, Panel } from "../ui";
import { Pitch } from "./Pitch";
import "../overlay.css";
import "../frame.css";
import "../dashboard/dashboard.css";

const lang = new URLSearchParams(location.search).get("lang");
if (lang && lang in LOCALES) setLocale(lang as Locale);
document.documentElement.dataset.view = "overlay";
document.documentElement.classList.add("dash-page");

// fc-tracker.com/s/<id> (Vercel rewrites it to this page), or ?id= in a preview
const id = location.pathname.match(/\/s\/([A-Za-z0-9]+)/)?.[1] ?? new URLSearchParams(location.search).get("id") ?? "";

function SharePage() {
  useLocale();
  useTheme();
  const [s, setS] = useState<SharedSquad | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  useEffect(() => {
    getShare(id)
      .then((x) => {
        setS(x);
        setState("ok");
        document.title = `${x.data.title} – FC-Tracker`;
      })
      .catch(() => setState("missing"));
  }, []);
  return (
    <div className="dv shp">
      <header className="shp-bar">
        <a className="dvs-brand" href={location.hostname === "dashboard.fc-tracker.com" ? "https://www.fc-tracker.com/" : "/"}>
          <Mark />
          <span>FC-Tracker</span>
        </a>
        <a className="btn btn-primary btn-s" href="https://www.fc-tracker.com/download">{t("share.cta")}</a>
      </header>
      <main className="dv-wrap dv-wide">
        {state === "loading" ? (
          <div className="col" style={{ gap: 10 }}>
            <p className="dv-muted">{t("share.loading")}</p>
            <Bar value={0} loading />
          </div>
        ) : state === "missing" || !s ? (
          <p className="dv-muted">{t("share.missing")}</p>
        ) : (
          <>
            <div className="dv-head">
              <div className="col" style={{ gap: 10, minWidth: 0 }}>
                <span className="eyebrow accent">{s.data.event}</span>
                <h1 className="dv-h1 dv-title">
                  {t("lh.obj.xi")} {t("lh.obj.count", { count: s.data.counted })}
                </h1>
                <p className="dv-muted">
                  {s.data.title} · {s.data.formation} · {t("lh.obj.chem", { count: s.data.chem })}
                </p>
              </div>
              <span className="dv-small">{s.by ? t("share.by", { name: s.by }) : t("share.anon")}</span>
            </div>
            <div className="shp-grid">
              <Panel className="dv-tile shp-pitch">
                <Pitch slots={s.data.slots} w={124} />
              </Panel>
              <Panel className="dv-tile">
                <span className="eyebrow">{t("share.objectives", { count: s.data.objectives.length })}</span>
                <div className="list rule">
                  {s.data.objectives.map((o, i) => (
                    <div key={i} className="lrow shp-obj">
                      <b className="strong">{o.name}</b>
                      <span className="dv-small">{o.text}</span>
                    </div>
                  ))}
                </div>
                <a className="btn btn-secondary ring btn-s" href={location.hostname === "dashboard.fc-tracker.com" ? "https://www.fc-tracker.com/" : "/"}>{t("share.more")}</a>
              </Panel>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SharePage />
  </React.StrictMode>,
);
