import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { t } from "./i18n";
import { SUPPORT_QR } from "./supportQr";
import "./support.css";

/**
 * "$ Support me" – a small gold button (overlay top bar, launcher header) that opens a panel with
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
      >
        <span className="support-coin" aria-hidden="true">
          $
        </span>
        {t("support.button")}
      </button>
      {open &&
        createPortal(
          <div
            className="support-panel"
            ref={panel}
            style={{ top: pos.top, right: pos.right }}
            role="dialog"
            aria-label={t("support.title")}
          >
            <b className="support-title">{t("support.title")}</b>
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
              className="support-open"
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
