// FC-Tracker Web stays current (user 2026-10-30: updates "INSTANT", some "Update required"):
// every build stamps /web/version.json (scripts/build-web.mjs). The page compares it with its own
// build – on start, every 5 minutes and whenever the tab comes back – and shows a new version at
// once; a required one blocks the page and reloads it by itself after a short countdown. The
// extension too: older than the page needs, it is asked to update itself right away.
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { askExtensionUpdate, onClub, webClub } from "./backend";
import { olderThan } from "../api";

const BUILD = Number(import.meta.env.VITE_WEB_BUILD ?? 0);
const EVERY_MS = 5 * 60_000;
const COUNTDOWN_S = 10;

interface Version {
  build: number;
  /** Builds older than this must reload. */
  required: number;
  /** The oldest extension this page works with. */
  extension_required?: string;
}

function useVersion(): Version | null {
  const [v, setV] = useState<Version | null>(null);
  useEffect(() => {
    if (!BUILD) return; // the dev server: nothing to compare
    const check = () =>
      fetch(`/web/version.json?t=${Date.now()}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => j && typeof j.build === "number" && setV(j))
        .catch(() => {});
    check();
    const id = window.setInterval(check, EVERY_MS);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);
  return v;
}

export default function WebUpdate() {
  const v = useVersion();
  const [club, setClub] = useState(webClub());
  const [left, setLeft] = useState(COUNTDOWN_S);
  useEffect(() => onClub(setClub), []);
  const required = !!v && v.required > BUILD;
  const newer = !!v && v.build > BUILD;
  const extOld = !!(v?.extension_required && club.version && club.version !== "?" && olderThan(club.version, v.extension_required));
  useEffect(() => {
    if (extOld) void askExtensionUpdate();
  }, [extOld]);
  useEffect(() => {
    if (!required) return;
    if (left <= 0) return void location.reload();
    const id = window.setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [required, left]);
  if (required) {
    return (
      <div className="upd-required" role="alertdialog" aria-live="assertive">
        <div className="upd-box">
          <span className="upd-mark" aria-hidden="true" />
          <h2>{t("update.web.requiredTitle")}</h2>
          <p>{t("update.web.requiredText")}</p>
          <p className="upd-wait">{t("update.web.countdown", { seconds: Math.max(0, left) })}</p>
          <button className="wb-btn" onClick={() => location.reload()}>
            {t("update.web.reload")}
          </button>
        </div>
      </div>
    );
  }
  if (!newer && !extOld) return null;
  return (
    <div className="wb-update" role="status">
      <span className="upd-mark" aria-hidden="true" />
      <p>{newer ? t("update.web.available") : t("update.ext.updating", { version: v?.extension_required ?? "" })}</p>
      {newer && (
        <button className="wb-btn" onClick={() => location.reload()}>
          {t("update.web.reload")}
        </button>
      )}
    </div>
  );
}
