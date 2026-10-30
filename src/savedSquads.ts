// Objective squads the user saved to build later (Objectives → "Save squad"): kept in this
// browser/app first, and on the account (sync part "saved") so the dashboard, the app and
// FC-Tracker Web all show the same list – plan on the phone, build when back in the game.
import { useEffect, useState } from "react";
import type { EventPlan } from "./squadsData";

const KEY = "fct.squads.saved";
const EVENT = "fct-saved-squads";

export type SavedSlot = { pos: string; name: string; def_id: number; rating: number; owned: boolean; price: number | null };
export type SavedSquad = {
  id: string;
  event: string;
  event_id: number;
  formation: string;
  met: number;
  reqs: number;
  saved_at: number;
  slots: SavedSlot[];
};

export function savedSquads(): SavedSquad[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(list: SavedSquad[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

/** Saves the XI of an event as it is built now (a new entry each time). */
export function saveSquad(e: EventPlan): SavedSquad | null {
  if (!e.squad) return null;
  const s: SavedSquad = {
    id: `${e.id}-${Date.now().toString(36)}`,
    event: e.title,
    event_id: e.id,
    formation: e.squad.formation,
    met: e.squad.met,
    reqs: e.reqs.length,
    saved_at: Date.now(),
    slots: e.squad.slots.map((s) => ({ pos: s.pos, name: s.name, def_id: s.def_id, rating: s.rating, owned: s.owned, price: s.price })),
  };
  write([s, ...savedSquads()].slice(0, 100));
  return s;
}

export function removeSquad(id: string) {
  write(savedSquads().filter((s) => s.id !== id));
}

/** Account sync: another device's list – taken (`replace`) or joined (by id, newest first). */
export function applySaved(incoming: SavedSquad[], replace: boolean) {
  const list = replace ? incoming : [...savedSquads(), ...incoming.filter((s) => !savedSquads().some((m) => m.id === s.id))];
  write(list.sort((a, b) => b.saved_at - a.saved_at).slice(0, 100));
}

export function useSavedSquads(): SavedSquad[] {
  const [list, set] = useState(savedSquads);
  useEffect(() => {
    const sync = () => set(savedSquads());
    const onStorage = (e: StorageEvent) => e.key === KEY && sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return list;
}

/** When the list last changed here (ms) – for the account sync's "written … ago". */
export function savedWrittenAt(): number {
  return savedSquads().reduce((m, s) => Math.max(m, s.saved_at), 0);
}
