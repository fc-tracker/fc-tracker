/**
 * The profile menu at the right of the overlay's top bar (app and FC-Tracker Web alike): the
 * user's picture or initial opens it. Everything that isn't a main thing lives here instead of in
 * the bar – profile & account, look (theme), zoom, window layout (app), language, help, support.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, IS_WEB } from "./api";
import { LOCALE_NAMES, t, useLocale, type Locale, type MessageKey } from "./i18n";
import { THEMES, type Theme } from "./theme";
import { SupportButton } from "./Support";
import { useAccount } from "./account";
import { ProfileDialog } from "./AccountSettings";

type Mode = "panel" | "half" | "full";

export function Avatar({ size = 26 }: { size?: number }) {
  const acc = useAccount();
  const u = acc.user;
  const initial = (u?.display_name ?? u?.email ?? "").trim().charAt(0).toUpperCase();
  return (
    <span className={`me-avatar ${acc.status === "in" ? "in" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      {u?.avatar_url ? <img src={u.avatar_url} alt="" /> : initial || <span className="me-avatar-blank" />}
    </span>
  );
}

export default function OverlayMenu(props: {
  theme: Theme;
  setTheme: (t: Theme) => void;
  zoom: number;
  setZoom: (dir: number) => void;
  mode?: Mode;
  changeMode?: (m: Mode) => void;
}) {
  const acc = useAccount();
  const [locale, setLocale] = useLocale();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  const toggle = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!btn.current?.contains(n) && !panel.current?.contains(n) && !(n as Element).closest?.(".support-panel")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btn.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const name = acc.status === "in" ? (acc.user?.display_name ?? acc.user?.email ?? t("settings.account")) : t("menu.signedOut");

  return (
    <>
      <button ref={btn} className={`me-btn ${open ? "active" : ""}`} onClick={toggle} aria-expanded={open} aria-haspopup="menu" title={t("menu.title")}>
        <Avatar size={22} />
        <span className="me-caret" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div ref={panel} className="me-menu" role="menu" aria-label={t("menu.title")} style={{ top: pos.top, right: pos.right }}>
            <div className="me-who">
              <Avatar size={36} />
              <div>
                <b>
                  {name}
                  {acc.user?.verified && <span className="me-verified" title={t("profile.verified")} aria-label={t("profile.verified")} />}
                </b>
                <small>{acc.status === "in" ? acc.user?.email : t("menu.signInHint")}</small>
              </div>
            </div>
            <button
              className="me-item primary"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setProfile(true);
              }}
            >
              {acc.status === "in" ? t("menu.profile") : t("menu.signIn")}
            </button>
            {IS_WEB && acc.status === "in" && !document.documentElement.classList.contains("dash-page") && (
              <a className="me-item" role="menuitem" href="/dashboard" target="_blank" rel="noopener">
                {t("menu.dashboard")}
              </a>
            )}

            <div className="me-group" role="group" aria-label={t("overlay.theme")}>
              <span className="me-label">{t("overlay.theme")}</span>
              <div className="me-row">
                {THEMES.map((th) => (
                  <button
                    key={th}
                    role="menuitemradio"
                    aria-checked={props.theme === th}
                    className={`me-swatch ${props.theme === th ? "on" : ""}`}
                    data-swatch={th}
                    title={t(`theme.${th}` as MessageKey)}
                    onClick={() => props.setTheme(th)}
                  >
                    <span aria-hidden="true" />
                    {t(`theme.${th}` as MessageKey)}
                  </button>
                ))}
              </div>
            </div>

            <div className="me-group" role="group" aria-label={t("overlay.zoom")}>
              <span className="me-label">{t("overlay.zoom")}</span>
              <div className="me-row me-zoom">
                <button className="me-chip" onClick={() => props.setZoom(-1)} aria-label={t("overlay.zoomOut")} title={t("overlay.zoomOut")}>
                  −
                </button>
                <button className="me-chip wide" onClick={() => props.setZoom(0)} title={t("overlay.zoomReset")}>
                  {Math.round(props.zoom * 100)} %
                </button>
                <button className="me-chip" onClick={() => props.setZoom(1)} aria-label={t("overlay.zoomIn")} title={t("overlay.zoomIn")}>
                  +
                </button>
              </div>
            </div>

            {!IS_WEB && props.mode && props.changeMode && (
              <div className="me-group" role="group" aria-label={t("overlay.mode.title")}>
                <span className="me-label">{t("overlay.mode.title")}</span>
                <div className="me-row">
                  {(["panel", "half", "full"] as const).map((m) => (
                    <button
                      key={m}
                      role="menuitemradio"
                      aria-checked={props.mode === m}
                      className={`me-chip ${props.mode === m ? "on" : ""}`}
                      onClick={() => props.changeMode!(m)}
                    >
                      <span className={`mode-icon mode-${m}`} aria-hidden="true" />
                      {t(`menu.mode.${m}` as MessageKey)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <label className="me-group me-lang">
              <span className="me-label">{t("language")}</span>
              <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
                {Object.entries(LOCALE_NAMES).map(([code, n]) => (
                  <option key={code} value={code}>
                    {n}
                  </option>
                ))}
              </select>
            </label>

            <div className="me-foot">
              <button
                className="me-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  void api.openHelp("controls");
                }}
              >
                {t("overlay.help")}
              </button>
              <SupportButton />
            </div>
          </div>,
          document.body,
        )}
      {profile && <ProfileDialog onClose={() => setProfile(false)} />}
    </>
  );
}
