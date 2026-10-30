// Updates the moment they are out (src-tauri/src/updates.rs): the watcher's news reaches every
// window at once. A required update blocks: "Update required", installed by itself after a
// short countdown as soon as FC 27 isn't running (never during a game – the installer would close
// FC-Tracker mid-session). The launcher and the overlay use the same pieces.
import { useEffect, useState } from "react";
import { api, events, type UpdateInfo } from "./api";
import { t, tError } from "./i18n";

const COUNTDOWN_S = 10;

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

/** The blocking "Update required" screen. `running`: FC 27 is open (the installer waits). */
export function RequiredUpdate({ update, running, overlay = false }: { update: UpdateInfo; running: boolean; overlay?: boolean }) {
  const [left, setLeft] = useState(COUNTDOWN_S);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const install = () => {
    setInstalling(true);
    setError(null);
    api.installUpdate().catch((e) => {
      setError(tError(e));
      setInstalling(false);
    });
  };
  // installs by itself (in the launcher) once the game is closed
  useEffect(() => {
    if (overlay || running || installing || error) return;
    if (left <= 0) return install();
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [left, running, installing, error, overlay]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`upd-required ${overlay ? "in-overlay" : ""}`} role="alertdialog" aria-live="assertive">
      <div className="upd-box">
        <span className="upd-mark" aria-hidden="true" />
        <h2>{t("update.required.title")}</h2>
        <p>{t("update.required.text", { current: update.current, version: update.version })}</p>
        {error ? (
          <p className="upd-error">{error}</p>
        ) : running ? (
          <p className="upd-wait">{t("update.required.closeGame")}</p>
        ) : installing ? (
          <p className="upd-wait ml-loading">{t("update.installing")}</p>
        ) : !overlay ? (
          <p className="upd-wait">{t("update.required.countdown", { seconds: Math.max(0, left) })}</p>
        ) : null}
        <button className="ln-btn" disabled={installing || running} onClick={install}>
          {installing ? t("update.installing") : t("update.required.now")}
        </button>
      </div>
    </div>
  );
}
