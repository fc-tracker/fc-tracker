// Zoom of the launcher (BRAND-MIGRATION relayed rule 8, as v1 and the overlay): Ctrl + scroll,
// Ctrl + / − / 0, or the − 100 % + buttons in Settings. The same steps as the overlay (Overlay.tsx
// ZOOMS), kept per window in `fct.zoom.launcher` – a smaller screen wants it smaller, the overlay
// keeps its own.
import { useCallback, useEffect, useState } from "react";

export const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4];
const KEY = "fct.zoom.launcher2";

const read = (): number => {
  try {
    const z = Number(localStorage.getItem(KEY) ?? "1");
    return ZOOMS.includes(z) ? z : 1;
  } catch {
    return 1;
  }
};

/** The next step: dir −1 smaller, +1 bigger, 0 = back to 100 %. */
export function stepZoom(z: number, dir: number): number {
  if (dir === 0) return 1;
  const i = ZOOMS.indexOf(z);
  return ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.indexOf(1) : i) + dir))];
}

/** The launcher's zoom and its keys (Ctrl + / − / 0, Ctrl + scroll). */
export function useLauncherZoom(): [number, (dir: number) => void] {
  const [zoom, setZoomState] = useState(read);
  const setZoom = useCallback((dir: number) => {
    setZoomState((z) => {
      const next = stepZoom(z, dir);
      try {
        localStorage.setItem(KEY, String(next));
      } catch {}
      return next;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0") {
        e.preventDefault();
        setZoom(e.key === "0" ? 0 : e.key === "-" ? -1 : 1);
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(e.deltaY < 0 ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, [setZoom]);
  return [zoom, setZoom];
}
