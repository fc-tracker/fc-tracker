import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import MissingList from "../MissingList";
import Overlay from "../Overlay";
import { t, useLocale, type MessageKey } from "../i18n";
import { num } from "../format";
import { useTheme } from "../theme";
import { captureDevices, onClub, openExtensionSignIn, startCapture, stopCapture, syncClub, webApi, webClub, webEvents, webStatus, webStream, type ClubSync, type Source, type WebStatus } from "./backend";
import { formatAge } from "../api";
import type { Box } from "./reader";
import WebUpdate from "./WebUpdate";
import SyncConflict from "../SyncConflict";
import { browserPad } from "../browserPad";

const DOWNLOAD = "/download";
const EXTENSION = "/download/extension";
/** The download prompt comes back after this many more reads. */
const NUDGE_EVERY = 3;

const SOURCES: { id: Source; icon: string }[] = [
  { id: "window", icon: "M3 5h18v11H3zM8 19h8M12 16v3" },
  { id: "tab", icon: "M3 6h18v13H3zM3 10h18M7 6V4h5v2" },
  { id: "card", icon: "M4 8h12v9H4zM16 11l4-2v7l-4-2M7 5h6" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="wb-icon">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function statusText(s: WebStatus): { text: string; tone: "" | "ok" | "warn" | "bad" | "busy" } {
  if (s.error && s.phase !== "reading") return { text: t(`web.error.${s.error}` as MessageKey), tone: "bad" };
  switch (s.phase) {
    case "off":
      return { text: t("web.status.off"), tone: "" };
    case "starting":
      return { text: t("web.status.starting"), tone: "busy" };
    case "watching":
      return { text: t("web.status.watching"), tone: "" };
    case "reading":
      return { text: s.set ? t("web.status.reading", { set: s.set, count: s.cards }) : t("web.status.readingPage", { count: s.cards }), tone: "busy" };
    case "read":
      return { text: t(s.verified ? "web.status.readVerified" : "web.status.read", { set: s.set ?? "", count: s.cards, ms: num(s.ms ?? 0) }), tone: s.verified ? "ok" : "" };
    case "unclear":
      return { text: t("web.status.unclear"), tone: "warn" };
    default:
      return { text: t("web.error.start_failed"), tone: "bad" };
  }
}

/** Live picture of what is shared, with the boxes the reader looked at. */
function Preview({ status }: { status: WebStatus }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [looked, setLooked] = useState<{ boxes: Box[]; w: number; h: number } | null>(null);
  useEffect(() => webEvents.onLooked(setLooked), []);
  useEffect(() => {
    if (video.current) video.current.srcObject = webStream();
  }, [status.source, status.phase === "off"]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.width = r.width * devicePixelRatio;
    c.height = r.height * devicePixelRatio;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    if (!looked) return;
    const k = Math.min(c.width / looked.w, c.height / looked.h);
    const ox = (c.width - looked.w * k) / 2, oy = (c.height - looked.h * k) / 2;
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#EF4359";
    g.lineWidth = Math.max(1, devicePixelRatio);
    for (const b of looked.boxes) g.strokeRect(ox + b.x * k, oy + b.y * k, b.w * k, b.h * k);
  }, [looked]);
  if (status.phase === "off") return null;
  return (
    <div className="wb-preview" aria-label={t("web.preview")}>
      <video ref={video} autoPlay muted playsInline />
      <canvas ref={canvas} />
      <span className="wb-preview-meta">{status.width ? t("web.stream", { w: status.width, h: status.height, fps: status.fps }) : t("web.status.starting")}</span>
    </div>
  );
}

/** The club sync through the extension: get it, sync, or when it last synced. */
function ClubChip() {
  const [c, setC] = useState<ClubSync>(webClub());
  useEffect(() => onClub(setC), []);
  if (!c.version)
    return (
      <a className="wb-club" href={EXTENSION} target="_blank" rel="noopener" title={t("web.sync.getHint")}>
        <span className="wb-club-dot off" aria-hidden="true" />
        {t("web.sync.get")}
      </a>
    );
  // the extension (v2) has no owner – no app paired, nobody signed in – so it won't sync: say so and open its sign-in
  if (c.owner === null)
    return (
      <button className="wb-club warn" onClick={() => void openExtensionSignIn()} title={t("v2web.ext.signInHint")}>
        <span className="wb-club-dot off" aria-hidden="true" />
        {t("v2web.ext.signIn")}
      </button>
    );
  if (c.reading)
    return (
      <span className="wb-club busy" role="status">
        <span className="wb-club-dot" aria-hidden="true" />
        {t("web.sync.reading")}
      </span>
    );
  // still clickable while it syncs: closed the Web App by mistake → open it again
  if (c.syncing)
    return (
      <button className="wb-club busy" onClick={() => void syncClub()} title={t("web.sync.getHint")}>
        <span className="wb-club-dot" aria-hidden="true" />
        {t("web.sync.running")}
      </button>
    );
  return (
    <button className="wb-club" onClick={() => void syncClub()} title={t("web.sync.getHint")}>
      <span className={`wb-club-dot ${c.readAt ? "on" : "off"}`} aria-hidden="true" />
      {c.readAt ? t("web.sync.done", { age: formatAge(c.readAt), cards: c.cards }) : t("web.sync.now")}
    </button>
  );
}

/** Choose what to read the game from (also opened by the overlay's tracking pill). */
function SourcePicker({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[] | null>(null);
  const [device, setDevice] = useState("");
  const [cardError, setCardError] = useState(false);
  const pick = async (s: Source) => {
    if (s === "card") {
      try {
        const list = await captureDevices();
        setDevices(list);
        const guess = list.find((d) => /elgato|capture|hd60|cam link|avermedia|usb video|hdmi|razer|genki/i.test(d.label)) ?? list[0];
        setDevice(guess?.deviceId ?? "");
        setCardError(list.length === 0);
      } catch {
        setCardError(true);
      }
      return;
    }
    onClose();
    await startCapture(s);
  };
  return (
    <div className="wb-picker" role="dialog" aria-label={t("web.source.title")}>
      <div className="wb-picker-head">
        <h2>{t("web.source.title")}</h2>
        <button className="wb-x" onClick={onClose} aria-label={t("web.close")}>×</button>
      </div>
      <div className="wb-sources">
        {SOURCES.map((s) => (
          <button key={s.id} className="wb-source" onClick={() => pick(s.id)}>
            <Icon d={s.icon} />
            <b>{t(`web.source.${s.id}` as MessageKey)}</b>
            <span>{t(`web.source.${s.id}Hint` as MessageKey)}</span>
          </button>
        ))}
      </div>
      {devices && devices.length > 0 && (
        <div className="wb-card-row">
          <select value={device} onChange={(e) => setDevice(e.target.value)} aria-label={t("web.card.pick")}>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || t("web.card.unnamed")}</option>
            ))}
          </select>
          <button className="btn btn-primary btn-s wb-btn" onClick={() => { onClose(); void startCapture("card", device); }}>{t("web.card.start")}</button>
        </div>
      )}
      {cardError && <p className="wb-note bad">{t("web.error.no_device")}</p>}
      <p className="wb-note">{t("web.borderless")}</p>
      <p className="wb-note">{t("web.intro.private")}</p>
    </div>
  );
}

/** The download prompt after a read: what the app does better, one button. */
function Nudge({ ms, onLater }: { ms: number | null; onLater: () => void }) {
  return (
    <aside className="wb-nudge" role="status">
      <b>{ms != null ? t("web.nudge.title", { ms: num(ms) }) : t("web.cta")}</b>
      <p>{t("web.nudge.text")}</p>
      <div className="wb-nudge-row">
        <a className="btn btn-primary btn-s wb-btn" href={DOWNLOAD} target="_blank" rel="noopener">{t("web.nudge.button")}</a>
        <button className="btn btn-secondary ring btn-s wb-btn" onClick={onLater}>{t("web.nudge.later")}</button>
      </div>
    </aside>
  );
}

/** Install FC-Tracker Web as its own app (PWA, user 2026-11-05: "so it feels like you really download it"): the
 *  browser's install prompt, offered in the header while it can be installed; gone once it runs as the app. */
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };
function useInstall() {
  const standalone = () => matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: window-controls-overlay)").matches;
  const [ev, setEv] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(standalone);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEv(e as InstallPrompt);
    };
    const done = () => {
      setEv(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", on);
    window.addEventListener("appinstalled", done);
    return () => {
      window.removeEventListener("beforeinstallprompt", on);
      window.removeEventListener("appinstalled", done);
    };
  }, []);
  const run = async () => {
    if (!ev) return;
    await ev.prompt();
    const { outcome } = await ev.userChoice;
    setEv(null);
    if (outcome === "accepted") setInstalled(true);
  };
  return { can: !!ev && !installed, installed, run };
}

/** The always-on-top mini window (Document Picture-in-Picture): the side panel for the set on screen. */
function usePip() {
  const [pip, setPip] = useState<Window | null>(null);
  const open = async () => {
    const dpip = (window as unknown as { documentPictureInPicture?: { requestWindow(o: object): Promise<Window> } }).documentPictureInPicture;
    if (!dpip) return;
    const w = await dpip.requestWindow({ width: 380, height: 560 });
    for (const node of document.head.querySelectorAll("style, link[rel=stylesheet]")) w.document.head.append(node.cloneNode(true));
    w.document.documentElement.dataset.view = "missing";
    w.document.documentElement.dataset.theme = document.documentElement.dataset.theme ?? "glass";
    w.document.documentElement.lang = document.documentElement.lang;
    w.document.title = "FC-Tracker";
    w.addEventListener("pagehide", () => setPip(null));
    setPip(w);
  };
  return { pip, open, supported: "documentPictureInPicture" in window };
}

export default function WebApp() {
  useLocale();
  const [theme] = useTheme();
  const [status, setStatus] = useState<WebStatus>(webStatus());
  const [picker, setPicker] = useState(false);
  const [nudgeAt, setNudgeAt] = useState(1);
  const [intro, setIntro] = useState(() => {
    try {
      return localStorage.getItem("fct.web.intro") !== "done";
    } catch {
      return true;
    }
  });
  const { pip, open: openPip, supported: pipSupported } = usePip();
  const install = useInstall();

  useEffect(() => webEvents.onStatus(setStatus), []);
  useEffect(() => {
    const show = () => setPicker(true);
    window.addEventListener("fct-web-source", show);
    return () => window.removeEventListener("fct-web-source", show);
  }, []);
  useEffect(() => {
    if (pip) pip.document.documentElement.dataset.theme = theme;
  }, [pip, theme]);
  // the intro closes for good: after the first read, its ×, Esc or ○ / B
  const closeIntro = () => {
    setIntro(false);
    try {
      localStorage.setItem("fct.web.intro", "done");
    } catch {}
  };
  useEffect(() => {
    if (status.phase === "read" && intro) closeIntro();
  }, [status.phase, intro]);
  // Esc / ○ B closes the top panel: the source picker, else the intro
  useEffect(() => {
    if (!picker && !intro) return;
    const back = () => (picker ? setPicker(false) : closeIntro());
    const key = (e: KeyboardEvent) => e.key === "Escape" && back();
    window.addEventListener("keydown", key);
    const off = browserPad.onNav((a) => a === "back" && back());
    return () => {
      window.removeEventListener("keydown", key);
      off();
    };
  }, [picker, intro]);

  const live = status.phase !== "off";
  const s = statusText(status);
  const nudge = status.reads >= nudgeAt && status.phase === "read";
  const introShown = intro && !live && !picker;
  // one red primary per view: the header's Share only while no panel carries its own
  const actions = (
    <span className="wb-acts">
      <ClubChip />
      {live ? (
        <>
          {pipSupported && (
            <button className="btn btn-secondary ring btn-s wb-btn" onClick={openPip} title={t("web.pipHint")} disabled={!!pip}>{t("web.pip")}</button>
          )}
          <button className="btn btn-secondary ring btn-s wb-btn" onClick={() => stopCapture()}>{t("web.stop")}</button>
        </>
      ) : (
        <button className={`btn ${introShown || picker ? "btn-secondary ring" : "btn-primary"} btn-s wb-btn`} onClick={() => setPicker(true)}>{t("web.share")}</button>
      )}
      {install.can ? (
        <button className="btn btn-secondary ring btn-s wb-btn" onClick={() => void install.run()} title={t("web.install.hint")}>{t("web.install.button")}</button>
      ) : (
        !install.installed && <a className="btn btn-secondary ring btn-s wb-btn" href={DOWNLOAD} target="_blank" rel="noopener" title={t("web.ctaHint")}>{t("web.cta")}</a>
      )}
    </span>
  );

  return (
    <div className="wb">

      {/* the overlay holds Best selection | Buy next itself (like the app in full screen) */}
      {/* one header: the overlay's own, with what is being read and the web's actions in it (no bar above it) */}
      <div className="wb-main">
        <div className="wb-ov">
          <Overlay web={{ label: status.phase === "off" && !status.error ? t("web.status.idle") : s.text, tone: s.tone, actions }} />
        </div>
      </div>

      <Preview status={status} />
      <WebUpdate />

      {introShown && (
        <section className="wb-intro" role="dialog" aria-labelledby="wb-intro-t">
          <div className="wb-picker-head">
            <h1 id="wb-intro-t">{t("web.intro.title")}</h1>
            <button className="wb-x" onClick={closeIntro} aria-label={t("web.close")} title={t("v2web.intro.closeHint")}>×</button>
          </div>
          <ol>
            <li>{t("web.intro.step1")}</li>
            <li>{t("web.intro.step2")}</li>
            <li>{t("v2web.intro.step3")}</li>
          </ol>
          <p className="wb-note">{t("web.intro.private")}</p>
          <div className="wb-nudge-row">
            <button className="btn btn-primary btn-s wb-btn" onClick={() => setPicker(true)}>{t("web.share")}</button>
            <a className="btn btn-secondary ring btn-s wb-btn" href={DOWNLOAD} target="_blank" rel="noopener">{t("web.intro.app")}</a>
          </div>
          <p className="wb-note">{t("web.console")}</p>
        </section>
      )}

      <SyncConflict />
      {picker && <SourcePicker onClose={() => setPicker(false)} />}
      {nudge && <Nudge ms={status.ms} onLater={() => setNudgeAt(status.reads + NUDGE_EVERY)} />}

      <footer className="wb-foot">
        <button className="wb-link" onClick={() => confirm(t("web.resetConfirm")) && webApi.reset()}>{t("web.reset")}</button>
        <span>{t("web.unofficial")}</span>
      </footer>

      {pip && createPortal(<MissingList />, pip.document.body)}
    </div>
  );
}
