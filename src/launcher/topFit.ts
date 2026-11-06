// The launcher's top bar never collides (review LA-1, same rule as the overlay): when its parts don't fit, items
// drop in a fixed order – one level at a time, measured, so every width and zoom gets the fullest bar that fits.
//   1 tagline · online count · version · the Support label (the glyph stays)
//   2 the slab leaves the centre (brand and status keep their own width, the slab centres in what is left)
//   3 the Q / E keycaps beside the slab (the footer still names the keys)
//   4 the coin balance
//   5 the brand word (the mark stays)
//   6 the tabs' counts, tighter tabs
//   7 the Support button
// styles.css reads the levels as classes `fit1 … fit7` on `.ln-top` (cumulative).
import { useLayoutEffect, type RefObject } from "react";

export const FIT_LEVELS = 7;

/** The room a part's content needs (its visible children side by side), against the room it has. */
function fits(part: Element | null): boolean {
  if (!part) return true;
  const el = part as HTMLElement;
  const kids = [...el.children].filter((k) => getComputedStyle(k).display !== "none") as HTMLElement[];
  if (!kids.length) return true;
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  const need = kids.reduce((s, k) => s + k.getBoundingClientRect().width, 0) + gap * (kids.length - 1);
  return need <= el.getBoundingClientRect().width + 0.5;
}

function barFits(top: HTMLElement): boolean {
  const tr = top.getBoundingClientRect();
  const parts = [".ln-brandline", ".ln-tabnav", ".ln-top-right"].map((s) => top.querySelector(s));
  if (!parts.every(fits)) return false;
  // the slab (auto column) inside the bar's padding, and the parts apart
  const rects = parts.filter((p): p is Element => !!p && getComputedStyle(p).display !== "none").map((p) => p.getBoundingClientRect());
  for (const r of rects) if (r.left < tr.left - 0.5 || r.right > tr.right + 0.5) return false;
  for (let i = 0; i + 1 < rects.length; i++) if (rects[i].right > rects[i + 1].left + 0.5) return false;
  const tabs = top.querySelector(".tabs") as HTMLElement | null;
  return !tabs || tabs.scrollWidth <= tabs.clientWidth + 1;
}

function apply(top: HTMLElement, level: number) {
  for (let i = 1; i <= FIT_LEVELS; i++) top.classList.toggle(`fit${i}`, i <= level);
}

/** Fit the bar now and on every resize of the bar or its contents (zoom, language, coins arriving). */
export function useTopFit(ref: RefObject<HTMLElement | null>, deps: unknown[]) {
  useLayoutEffect(() => {
    const top = ref.current;
    if (!top) return;
    const fit = () => {
      let level = 0;
      apply(top, level);
      while (level < FIT_LEVELS && !barFits(top)) apply(top, ++level);
      top.dataset.fit = String(level);
    };
    fit();
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(fit);
    });
    ro.observe(top);
    // fonts arriving change every width
    void document.fonts?.ready.then(fit);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
