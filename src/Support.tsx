import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { t } from "./i18n";
import { SUPPORT_QR } from "./supportQr";
/** Support's own glyph: a heart on a cut-corner plate – the coin glyph stays for coins only. */
const SupportGlyph = () => (
  <svg className="support-glyph" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 1h12v12l-2 2H1V3z" fill="currentColor" opacity=".18" />
    <path d="M8 12.2 4.1 8.4a2.3 2.3 0 0 1 3.3-3.3l.6.6.6-.6a2.3 2.3 0 0 1 3.3 3.3z" fill="currentColor" />
  </svg>
);
import "./support.css";

/**
 * "Support me" – a small quiet button with the coin glyph (overlay top bar, launcher header) that opens a panel with
 * a QR code: scan with the phone and pay with Apple Pay / Google Pay without leaving the game.
 * The QR is drawn locally; nothing is loaded until the user opens the link.
 */
export function SupportButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The panel lives on <body> (the top bars clip their children), placed under the button.
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r)
      setPos({
        top: r.bottom + 10,
        right: Math.max(8, window.innerWidth - r.right),
      });
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !panel.current?.contains(target))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`support ${className}`} ref={ref}>
      <button
        className={`support-btn ${open ? "active" : ""}`}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t("support.hint")}
        aria-label={t("support.button")}
      >
        <SupportGlyph />
        <span className="support-label">{t("support.button")}</span>
      </button>
      {open &&
        createPortal(
          <div
            className="support-panel panel ring"
            ref={panel}
            style={{ top: pos.top, right: pos.right }}
            role="dialog"
            aria-label={t("support.title")}
          >
            <b className="h3 support-title">{t("support.title")}</b>
            <p>{t("support.text")}</p>
            <div className="support-qr">
              <svg
                viewBox={SUPPORT_QR.viewBox}
                shapeRendering="crispEdges"
                role="img"
                aria-label={t("support.qr")}
              >
                <rect width="100%" height="100%" fill="#fff" />
                <path stroke="#000" d={SUPPORT_QR.d} />
              </svg>
            </div>
            <p className="support-scan">{t("support.scan")}</p>
            <button
              className="btn btn-secondary ring btn-s support-open"
              onClick={() => api.openSite("/support").catch(() => {})}
            >
              {t("support.open")}
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
