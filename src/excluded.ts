// Cards the user left out of Best value (✕ on a card): never planned, the next best card takes the
// place. Kept on this device (app and FC-Tracker Web alike) and sent with every Best value call.
import { useEffect, useState } from "react";

const KEY = "fct.excluded";

export type ExcludedCard = { id: number; name: string | null; rating: number | null };

function read(): ExcludedCard[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((c) => typeof c?.id === "number") : [];
  } catch {
    return [];
  }
}

let cards = read();
const listeners = new Set<() => void>();

function save(next: ExcludedCard[]) {
  cards = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((l) => l());
}

export const excludedIds = (): number[] => cards.map((c) => c.id);

export function excludeCard(card: { def_id: number; name?: string | null; rating?: number | null }) {
  if (cards.some((c) => c.id === card.def_id)) return;
  save([...cards, { id: card.def_id, name: card.name ?? null, rating: card.rating ?? null }]);
}

export function includeCard(id: number | "all") {
  save(id === "all" ? [] : cards.filter((c) => c.id !== id));
}

/** The left-out cards; re-renders when they change. */
export function useExcluded(): ExcludedCard[] {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return cards;
}
