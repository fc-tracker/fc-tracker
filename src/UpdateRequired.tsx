// Updates the moment they are out (src-tauri/src/updates.rs): the watcher's news reaches every
// window at once. Every update is forced (user 2026-11-04): the popup says "Update when FC 27
// closes" – there is no "Later". With the game closed it installs after a short countdown; with the
// game open it waits, and the app installs it by itself once FC 27 has been closed (also from the
// tray). Never during a game – the installer would close FC-Tracker mid-session. After the update
// the launcher opens with "Updated to …" once. Design: design/d-draft-2/12-installer-update.
import { useEffect, useState } from "react";
import { api, events, type UpdateInfo, type UpdatedInfo } from "./api";
import { t, tError } from "./i18n";
import { Btn, Dot, Keycap } from "./ui";
import "./update.css";

const COUNTDOWN_S = 10;
const UPDATED_MS = 9000;

/** The latest release the watcher knows about (null: up to date). */
export function useUpdate(): UpdateInfo | null {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    api.updateState().then(setUpdate).catch(() => {});
    // a window opened later asks once itself; the watcher pushes everything after that
    api.checkUpdate().then(setUpdate).catch(() => {});
    const un = events.onUpdate(setUpdate);
    const onVisible = () => document.visibilityState === "visible" && api.updateState().then(setUpdate).catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      un.then((u) => u());
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return update;
}

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" />
  </svg>
);

/** A lower-third (tag + title + sub), the broadcast package of 08 / 12. */
function LowerThird({ kind, title, sub, timer }: { kind: "ink" | "done"; title: string; sub: string; timer?: number }) {
  return (
    <div className="fu-l3" role="status">
      <span className={`fu-l3-tag ${kind}`}>{kind === "done" ? <CheckIcon /> : <DownloadIcon />}</span>
      <div className="fu-l3-body">
        <span className="fu-l3-title">{title}</span>
        <span className="fu-l3-sub">{sub}</span>
        {timer ? <span className="fu-l3-time" style={{ animationDuration: `${timer}ms` }} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/**
 * The forced update. Launcher: the popup (no "Later"); once the user said "Update when FC 27
 * closes" while the game runs, it folds into a strip so the launcher stays usable – it still installs
 * by itself. Overlay: a lower-third ("nothing to do now"); only an app that can't read the newest
 * data (`data_change`) blocks the overlay. `running`: FC 27 is open.
 */
export function RequiredUpdate({ update, running, overlay = false }: { update: UpdateInfo; running: boolean; overlay?: boolean }) {
  const [left, setLeft] = useState(COUNTDOWN_S);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folded, setFolded] = useState(false);
  const auto = update.auto !== false;
  const install = () => {
    setInstalling(true);
    setError(null);
    api.installUpdate().catch((e) => {
      setError(tError(e));
      setInstalling(false);
    });
  };
  useEffect(() => {
    const un = events.onUpdateInstalling(() => setInstalling(true));
    return () => void un.then((u) => u());
  }, []);
  // ✕ / A presses the one button: it has the focus (the overlay keeps its own focus)
  useEffect(() => {
    if (!overlay) document.querySelector<HTMLElement>(".fu-btn")?.focus();
  }, [overlay, running]);
  // the countdown starts over each time the game is closed
  useEffect(() => setLeft(COUNTDOWN_S), [running]);
  // installs by itself (in the launcher) once the game is closed
  useEffect(() => {
    if (overlay || running || installing || error || !auto) return;
    if (left <= 0) return install();
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left, running, installing, error, overlay, auto]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocking = !overlay || !!update.data_change;
  if (!blocking) return <div className="fu-l3-dock">{<LowerThird kind="ink" title={t("update.forced.title", { version: update.version })} sub={t("update.forced.l3Sub")} />}</div>;

  const status = error ? (
    <p className="fu-status error">{error}</p>
  ) : installing ? (
    <p className="fu-status ml-loading">
      <span>{t("update.installing")}</span>
      <i className="fu-bar loading" aria-hidden="true" />
    </p>
  ) : running ? (
    <p className="fu-status">
      <span>{t("update.forced.waiting")}</span>
      <i className="fu-bar loading" aria-hidden="true" />
    </p>
  ) : auto && !overlay ? (
    <p className="fu-status">
      <span>{t("update.required.countdown", { seconds: Math.max(0, left) })}</span>
      <i className="fu-bar" aria-hidden="true">
        <i style={{ width: `${(100 * (COUNTDOWN_S - Math.max(0, left))) / COUNTDOWN_S}%` }} />
      </i>
    </p>
  ) : null;

  // the launcher stays usable while the game runs; the update still installs by itself
  if (folded && running && !update.data_change && !overlay) {
    return (
      <div className="fu-strip" role="status">
        <span className="fu-strip-tag">
          <DownloadIcon />
        </span>
        <span className="fu-strip-text">{t("update.forced.strip", { version: update.version })}</span>
        <i className="fu-bar loading" aria-hidden="true" />
      </div>
    );
  }

  const primary = running ? t("update.forced.whenClosed") : installing ? t("update.installing") : t("update.required.now");
  return (
    <div className={`fu-scrim ${overlay ? "in-overlay" : ""}`} role="alertdialog" aria-modal="true" aria-live="assertive" aria-labelledby="fu-title">
      <section className="panel xl ring signed fu-panel">
        <span className="fu-ic">
          <DownloadIcon />
        </span>
        <div className="fu-body">
          <h2 id="fu-title">{update.data_change ? t("update.forced.titleData") : t("update.forced.title", { version: update.version })}</h2>
          <p className="fu-text">
            {update.data_change ? t("update.forced.textData", { version: update.version }) : t("update.forced.text", { version: update.version })}
          </p>
          {status}
          <div className="fu-actions">
            <Btn kind="primary" className="fu-btn" disabled={installing} onClick={() => (running ? setFolded(true) : install())}>
              <Keycap ps="✕" xb="A" kb="Enter" /> {primary}
            </Btn>
          </div>
          {/* 12: where the build comes from (every release is built on GitHub from the public source and attested) */}
          <p className="row t-13 faint fu-attested">
            <Dot tone="done" />
            <span>
              {t("lh.attested")} <b className="strong">gh attestation verify</b>
            </span>
          </p>
        </div>
      </section>
    </div>
  );
}

/** "Updated to …" – once, on the first start after an update (12: "once, then gone"). */
export function UpdatedNotice() {
  const [updated, setUpdated] = useState<UpdatedInfo | null>(null);
  useEffect(() => {
    api.updatedNotice().then(setUpdated).catch(() => {});
  }, []);
  useEffect(() => {
    if (!updated) return;
    const id = window.setTimeout(() => setUpdated(null), UPDATED_MS);
    return () => window.clearTimeout(id);
  }, [updated]);
  if (!updated) return null;
  return (
    <div className="fu-l3-dock launcher">
      <LowerThird kind="done" title={t("update.updated.title", { version: updated.version })} sub={t("update.updated.sub")} timer={UPDATED_MS} />
    </div>
  );
}
