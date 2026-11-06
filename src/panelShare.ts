// What the overlay and the side panel share between their windows (T24, user 2026-11-04): the
// objective plan they already worked out, and the objective session the user picked. Every app
// window has the same origin, so localStorage is one store for all of them; a Tauri event tells
// the other windows at once (a plain browser – the dev preview – hears the `storage` event).
import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import type { SquadsView } from "./squadsData";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const read = <T,>(k: string): T | null => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // full or blocked: the other window works it out itself
  }
};

// ---------- the plan ----------

const PLAN_KEY = "fct.squads.shared";
export type SharedPlan = { at: number; view: SquadsView };

/** The last plan any window worked out (null = none yet). */
export const sharedPlan = (): SharedPlan | null => read<SharedPlan>(PLAN_KEY);

/** A window worked the plan out: every other window can show it without working it out again. */
export function sharePlan(view: SquadsView): SquadsView {
  write(PLAN_KEY, { at: Date.now(), view } satisfies SharedPlan);
  if (inTauri) void emit("squads-plan-shared").catch(() => {});
  return view;
}

/** Another window shared a newer plan. */
export function onSharedPlan(cb: (p: SharedPlan) => void): () => void {
  const fromStore = () => {
    const p = sharedPlan();
    if (p) cb(p);
  };
  const onStorage = (e: StorageEvent) => e.key === PLAN_KEY && fromStore();
  window.addEventListener("storage", onStorage);
  const un = inTauri ? listen("squads-plan-shared", fromStore) : null;
  return () => {
    window.removeEventListener("storage", onStorage);
    void un?.then((u) => u());
  };
}

// ---------- the picked session (the overlay's L2/R2 session tabs) ----------

const PICK_KEY = "fct.squads.session";
/** A pick holds for the "Playing" choice it was made under – another event or place starts over. */
type Pick = { id: number; primary: number | null; place: string | null };
const pickListeners = new Set<(p: Pick | null) => void>();
let pickStarted = false;
function startPick() {
  if (pickStarted) return;
  pickStarted = true;
  const push = (p: Pick | null) => pickListeners.forEach((l) => l(p));
  window.addEventListener("storage", (e) => e.key === PICK_KEY && push(read<Pick>(PICK_KEY)));
  if (inTauri) void listen<Pick | null>("squads-session-pick", (e) => push(e.payload)).catch(() => {});
}
const ctxOf = (view: SquadsView | null) => ({ primary: view?.primary ?? null, place: view?.prefs?.place ? JSON.stringify(view.prefs.place) : null });

/**
 * The objective session shown – the same in the overlay and the side panel: picking one in either
 * window shows it in the other. `null` = the first session (the user's "Playing" pick or Auto).
 */
export function useSessionPick(view: SquadsView | null): [number | null, (id: number | null) => void] {
  const [pick, setPick] = useState<Pick | null>(() => read<Pick>(PICK_KEY));
  useEffect(() => {
    startPick();
    pickListeners.add(setPick);
    return () => void pickListeners.delete(setPick);
  }, []);
  const ctx = ctxOf(view);
  const id = pick && pick.primary === ctx.primary && pick.place === ctx.place ? pick.id : null;
  const choose = (next: number | null) => {
    const p: Pick | null = next == null ? null : { id: next, ...ctxOf(view) };
    write(PICK_KEY, p);
    // this window (and the overlay's embedded panel in the same page) at once, the others by event
    pickListeners.forEach((l) => l(p));
    if (inTauri) void emit("squads-session-pick", p).catch(() => {});
  };
  return [id, choose];
}
