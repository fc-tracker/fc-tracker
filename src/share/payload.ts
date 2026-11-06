// A session's squad as the public share copy (dashboard "Share link"): the cards as the game shows them – never
// coins, prices or item ids (the server strips those too, share.rs).
import type { SharePayload } from "../account";
import type { SessionPlan, SlotView } from "../squadsData";

export function sharePayload(s: SessionPlan): SharePayload | null {
  if (!s.squad) return null;
  return {
    title: s.title,
    event: s.place_name,
    place: s.place.kind,
    formation: s.squad.formation,
    chem: s.squad.chem,
    counted: s.counted,
    slots: s.squad.slots.map((x) => {
      const a = x as SlotView & { rareflag?: number; club?: number; positions?: string[] };
      return { art: (x as SlotView & { art?: string | null }).art ?? null, pos: x.pos, name: x.name, rating: x.rating, positions: a.positions, rareflag: a.rareflag ?? null, def_id: x.def_id || null, nation: x.nation || null, league: x.league || null, club: a.club ?? null, owned: x.owned };
    }),
    objectives: s.items.filter((i) => i.counts && !i.bonus).map((i) => ({ name: i.name || i.event_title, text: i.text, target: i.target })),
  };
}
