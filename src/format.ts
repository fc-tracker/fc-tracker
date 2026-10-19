import type { GalleryCardView } from "./api";
import { getLocale } from "./i18n";

export const num = (n: number) => n.toLocaleString(getLocale());

export const compact = (n: number) =>
  new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** Card colour group like in-game: special (non-base rarity), gold, silver, bronze. */
export function cardTier(c: GalleryCardView): string {
  if ((c.rareflag ?? 0) > 1) return "special";
  const r = c.rating ?? 0;
  return r >= 75 ? "gold" : r >= 65 ? "silver" : "bronze";
}
